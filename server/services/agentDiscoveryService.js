/**
 * Agent Discovery Service
 * Discovers Auto-Claude agent pods from Kubernetes API and enriches with Redis state
 */

import k8s from '@kubernetes/client-node';
import { createClient } from 'redis';

const NAMESPACE = process.env.KUBERNETES_NAMESPACE || 'madfam-automation';
const AGENT_LABEL_SELECTOR = 'app=auto-claude-agent';
const IN_CLUSTER = process.env.IN_CLUSTER === 'true';

// Kubernetes client
let k8sApi = null;

// Redis client
let redisClient = null;

/**
 * Initialize Kubernetes client
 */
function initKubernetesClient() {
  if (k8sApi) return k8sApi;

  const kc = new k8s.KubeConfig();

  if (IN_CLUSTER) {
    // Load in-cluster config when running inside Kubernetes
    kc.loadFromCluster();
  } else {
    // Load from kubeconfig file for local development
    kc.loadFromDefault();
  }

  k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  return k8sApi;
}

/**
 * Initialize Redis client
 */
async function initRedisClient() {
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  redisClient = createClient({ url: redisUrl });

  redisClient.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  await redisClient.connect();
  console.log('✅ Connected to Redis for agent discovery');

  return redisClient;
}

/**
 * Discover Auto-Claude agent pods from Kubernetes
 * @returns {Promise<Array>} List of agent pods with metadata
 */
async function discoverAgentPods() {
  try {
    const api = initKubernetesClient();

    const response = await api.listNamespacedPod(
      NAMESPACE,
      undefined, // pretty
      undefined, // allowWatchBookmarks
      undefined, // continue
      undefined, // fieldSelector
      AGENT_LABEL_SELECTOR // labelSelector
    );

    const pods = response.body.items.map(pod => ({
      name: pod.metadata.name,
      uid: pod.metadata.uid,
      phase: pod.status.phase,
      ready: pod.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
      podIP: pod.status.podIP,
      nodeName: pod.spec.nodeName,
      startTime: pod.status.startTime,
      containerStatuses: pod.status.containerStatuses?.map(cs => ({
        name: cs.name,
        ready: cs.ready,
        restartCount: cs.restartCount,
        state: Object.keys(cs.state || {})[0] // running, waiting, terminated
      }))
    }));

    return pods;
  } catch (error) {
    console.error('Failed to discover agent pods from Kubernetes:', error);
    throw new Error(`Kubernetes API error: ${error.message}`);
  }
}

/**
 * Get agent state from Redis
 * @param {string} agentId - Agent pod name
 * @returns {Promise<Object|null>} Agent state or null if not found
 */
async function getAgentStateFromRedis(agentId) {
  try {
    const redis = await initRedisClient();

    // Get agent state from Redis hash
    const agentState = await redis.hGetAll(`agent:${agentId}`);

    if (!agentState || Object.keys(agentState).length === 0) {
      return null;
    }

    return {
      status: agentState.status || 'unknown',
      currentTask: agentState.task || null,
      worktreePath: agentState.worktree || null,
      lastHeartbeat: agentState.lastHeartbeat ? new Date(agentState.lastHeartbeat) : null,
      tasksCompleted: parseInt(agentState.tasksCompleted || '0'),
      tasksFailed: parseInt(agentState.tasksFailed || '0')
    };
  } catch (error) {
    console.error(`Failed to get agent state for ${agentId} from Redis:`, error);
    return null;
  }
}

/**
 * Discover all Auto-Claude agents with enriched state
 * @returns {Promise<Array>} List of agents with K8s + Redis state
 */
export async function discoverAgents() {
  try {
    // Get pods from Kubernetes
    const pods = await discoverAgentPods();

    // Enrich with Redis state
    const agents = await Promise.all(
      pods.map(async (pod) => {
        const redisState = await getAgentStateFromRedis(pod.name);

        return {
          id: pod.name,
          uid: pod.uid,
          status: pod.ready ? 'ready' : pod.phase.toLowerCase(),
          podStatus: pod.phase,
          ready: pod.ready,
          podIP: pod.podIP,
          nodeName: pod.nodeName,
          startTime: pod.startTime,
          containers: pod.containerStatuses,
          // Redis state
          agentStatus: redisState?.status || 'unknown',
          currentTask: redisState?.currentTask,
          worktreePath: redisState?.worktreePath,
          lastHeartbeat: redisState?.lastHeartbeat,
          metrics: {
            tasksCompleted: redisState?.tasksCompleted || 0,
            tasksFailed: redisState?.tasksFailed || 0
          }
        };
      })
    );

    return agents;
  } catch (error) {
    console.error('Failed to discover agents:', error);
    throw error;
  }
}

/**
 * Get details for a specific agent
 * @param {string} agentId - Agent pod name
 * @returns {Promise<Object>} Agent details
 */
export async function getAgentDetails(agentId) {
  try {
    const api = initKubernetesClient();

    // Get pod details from Kubernetes
    const pod = await api.readNamespacedPod(agentId, NAMESPACE);

    // Get state from Redis
    const redisState = await getAgentStateFromRedis(agentId);

    return {
      id: pod.body.metadata.name,
      uid: pod.body.metadata.uid,
      status: pod.body.status.phase,
      ready: pod.body.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
      podIP: pod.body.status.podIP,
      nodeName: pod.body.spec.nodeName,
      startTime: pod.body.status.startTime,
      labels: pod.body.metadata.labels,
      containers: pod.body.status.containerStatuses,
      // Redis state
      agentStatus: redisState?.status || 'unknown',
      currentTask: redisState?.currentTask,
      worktreePath: redisState?.worktreePath,
      lastHeartbeat: redisState?.lastHeartbeat,
      metrics: {
        tasksCompleted: redisState?.tasksCompleted || 0,
        tasksFailed: redisState?.tasksFailed || 0
      }
    };
  } catch (error) {
    console.error(`Failed to get agent details for ${agentId}:`, error);
    throw error;
  }
}

/**
 * Get agent logs from Kubernetes
 * @param {string} agentId - Agent pod name
 * @param {string} containerName - Container name (default: auto-claude)
 * @param {number} tailLines - Number of lines to tail (default: 100)
 * @returns {Promise<string>} Agent logs
 */
export async function getAgentLogs(agentId, containerName = 'auto-claude', tailLines = 100) {
  try {
    const api = initKubernetesClient();

    const logs = await api.readNamespacedPodLog(
      agentId,
      NAMESPACE,
      containerName,
      undefined, // follow
      undefined, // insecureSkipTLSVerifyBackend
      undefined, // limitBytes
      undefined, // pretty
      undefined, // previous
      undefined, // sinceSeconds
      tailLines, // tailLines
      undefined  // timestamps
    );

    return logs.body;
  } catch (error) {
    console.error(`Failed to get logs for agent ${agentId}:`, error);
    throw error;
  }
}

/**
 * Check if agent discovery is available
 * @returns {Promise<boolean>}
 */
export async function isAgentDiscoveryAvailable() {
  try {
    await initKubernetesClient();
    await initRedisClient();
    return true;
  } catch (error) {
    console.error('Agent discovery not available:', error);
    return false;
  }
}

export default {
  discoverAgents,
  getAgentDetails,
  getAgentLogs,
  isAgentDiscoveryAvailable
};
