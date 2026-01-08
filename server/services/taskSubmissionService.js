/**
 * Task Submission Service
 * Manages task queue for Auto-Claude agents via Redis
 */

import { createClient } from 'redis';
import crypto from 'crypto';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TASK_QUEUE_PREFIX = 'autoclaudeQueue';
const TASK_DETAILS_PREFIX = 'task';

let redisClient = null;

/**
 * Initialize Redis client
 */
async function getRedisClient() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  redisClient = createClient({ url: REDIS_URL });

  redisClient.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  await redisClient.connect();
  console.log('✅ Connected to Redis for task management');

  return redisClient;
}

/**
 * Generate unique task ID
 * @returns {string} Task ID
 */
function generateTaskId() {
  const timestamp = Date.now().toString(36);
  const randomPart = crypto.randomBytes(4).toString('hex');
  return `task-${timestamp}-${randomPart}`;
}

/**
 * Submit a task to the Auto-Claude agent queue
 * @param {Object} taskSpec - Task specification
 * @param {string} taskSpec.instruction - Natural language instruction
 * @param {string} taskSpec.repository - Repository name (e.g., 'janua', 'enclii')
 * @param {string} taskSpec.branch - Target branch (optional, defaults to 'main')
 * @param {number} taskSpec.priority - Task priority 1-5 (1=critical, 5=low, default=3)
 * @param {Object} taskSpec.context - Additional context (files, requirements, etc.)
 * @param {string} userId - User ID submitting the task
 * @returns {Promise<Object>} Task submission result with taskId
 */
export async function submitTask(taskSpec, userId) {
  const redis = await getRedisClient();

  // Validate task specification
  if (!taskSpec.instruction || !taskSpec.repository) {
    throw new Error('Task must include instruction and repository');
  }

  // Generate task ID
  const taskId = generateTaskId();

  // Create full task object
  const task = {
    id: taskId,
    instruction: taskSpec.instruction,
    repository: taskSpec.repository,
    branch: taskSpec.branch || 'main',
    priority: taskSpec.priority || 3,
    context: taskSpec.context || {},
    submittedBy: userId,
    submittedAt: new Date().toISOString(),
    status: 'pending',
    agentId: null,
    startedAt: null,
    completedAt: null,
    result: null,
    error: null
  };

  // Store task details in Redis hash
  await redis.hSet(`${TASK_DETAILS_PREFIX}:${taskId}`, {
    ...task,
    context: JSON.stringify(task.context)
  });

  // Add task to priority queue (lower priority number = higher priority)
  const queueKey = `${TASK_QUEUE_PREFIX}:pending`;
  const score = task.priority * 1000000 + Date.now(); // Priority + timestamp for FIFO within priority

  await redis.zAdd(queueKey, {
    score: score,
    value: taskId
  });

  console.log(`✅ Task ${taskId} submitted to queue by user ${userId}`);

  return {
    taskId,
    status: 'pending',
    queuePosition: await getQueuePosition(taskId),
    estimatedWaitTime: await estimateWaitTime()
  };
}

/**
 * Get task details
 * @param {string} taskId - Task ID
 * @returns {Promise<Object|null>} Task details or null if not found
 */
export async function getTaskDetails(taskId) {
  const redis = await getRedisClient();

  const taskData = await redis.hGetAll(`${TASK_DETAILS_PREFIX}:${taskId}`);

  if (!taskData || Object.keys(taskData).length === 0) {
    return null;
  }

  return {
    ...taskData,
    context: JSON.parse(taskData.context || '{}')
  };
}

/**
 * Get all tasks for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} List of user's tasks
 */
export async function getUserTasks(userId) {
  const redis = await getRedisClient();

  // Scan for all task keys
  const taskKeys = [];
  for await (const key of redis.scanIterator({
    MATCH: `${TASK_DETAILS_PREFIX}:*`,
    COUNT: 100
  })) {
    taskKeys.push(key);
  }

  // Get tasks submitted by this user
  const tasks = [];
  for (const key of taskKeys) {
    const taskData = await redis.hGetAll(key);
    if (taskData.submittedBy === userId) {
      tasks.push({
        ...taskData,
        context: JSON.parse(taskData.context || '{}')
      });
    }
  }

  // Sort by submission time (newest first)
  tasks.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

  return tasks;
}

/**
 * Get queue statistics
 * @returns {Promise<Object>} Queue statistics
 */
export async function getQueueStats() {
  const redis = await getRedisClient();

  const [pending, active, completed, failed] = await Promise.all([
    redis.zCard(`${TASK_QUEUE_PREFIX}:pending`),
    redis.lLen(`${TASK_QUEUE_PREFIX}:active`),
    redis.lLen(`${TASK_QUEUE_PREFIX}:completed`),
    redis.lLen(`${TASK_QUEUE_PREFIX}:failed`)
  ]);

  return {
    pending,
    active,
    completed,
    failed,
    total: pending + active + completed + failed
  };
}

/**
 * Get position of task in queue
 * @param {string} taskId - Task ID
 * @returns {Promise<number|null>} Queue position (0-indexed) or null if not in queue
 */
async function getQueuePosition(taskId) {
  const redis = await getRedisClient();

  const rank = await redis.zRank(`${TASK_QUEUE_PREFIX}:pending`, taskId);
  return rank !== null ? rank : null;
}

/**
 * Estimate wait time based on queue depth and agent count
 * @returns {Promise<number>} Estimated wait time in seconds
 */
async function estimateWaitTime() {
  const redis = await getRedisClient();

  const queueDepth = await redis.zCard(`${TASK_QUEUE_PREFIX}:pending`);

  // Rough estimate: 10 minutes per task, divided by number of agents
  // This should be refined based on actual metrics
  const avgTaskDuration = 600; // 10 minutes in seconds
  const estimatedAgents = Math.max(1, Math.ceil(queueDepth / 3)); // KEDA scaling: 1 agent per 3 tasks

  return Math.ceil((queueDepth * avgTaskDuration) / estimatedAgents);
}

/**
 * Cancel a pending task
 * @param {string} taskId - Task ID
 * @param {string} userId - User ID (for authorization check)
 * @returns {Promise<Object>} Cancellation result
 */
export async function cancelTask(taskId, userId) {
  const redis = await getRedisClient();

  // Get task details
  const task = await getTaskDetails(taskId);

  if (!task) {
    throw new Error('Task not found');
  }

  // Verify user owns this task
  if (task.submittedBy !== userId) {
    throw new Error('Not authorized to cancel this task');
  }

  // Only allow cancellation of pending tasks
  if (task.status !== 'pending') {
    throw new Error(`Cannot cancel task with status: ${task.status}`);
  }

  // Remove from pending queue
  await redis.zRem(`${TASK_QUEUE_PREFIX}:pending`, taskId);

  // Update task status
  await redis.hSet(`${TASK_DETAILS_PREFIX}:${taskId}`, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    cancelledBy: userId
  });

  console.log(`✅ Task ${taskId} cancelled by user ${userId}`);

  return {
    taskId,
    status: 'cancelled',
    message: 'Task cancelled successfully'
  };
}

/**
 * Parse natural language instruction into structured task spec
 * Simple heuristic-based parsing (can be enhanced with LLM in future)
 * @param {string} instruction - Natural language instruction
 * @returns {Object} Partial task spec
 */
export function parseNaturalLanguageInstruction(instruction) {
  // Extract repository mentions
  const repoPattern = /\b(janua|enclii|sim4d|avala|forj|forgesight|cotiza-studio|dhanam)\b/i;
  const repoMatch = instruction.match(repoPattern);

  // Extract priority keywords
  let priority = 3; // default
  if (/urgent|critical|asap|immediately/i.test(instruction)) {
    priority = 1;
  } else if (/important|soon/i.test(instruction)) {
    priority = 2;
  } else if (/low priority|whenever|eventually/i.test(instruction)) {
    priority = 4;
  }

  return {
    repository: repoMatch ? repoMatch[1].toLowerCase() : null,
    priority,
    suggestedRepository: repoMatch ? repoMatch[1].toLowerCase() : null
  };
}

export default {
  submitTask,
  getTaskDetails,
  getUserTasks,
  getQueueStats,
  cancelTask,
  parseNaturalLanguageInstruction
};
