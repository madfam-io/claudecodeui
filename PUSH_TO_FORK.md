# Push ClaudeCodeUI Integration to Fork

**Location**: `/Users/aldoruizluna/labspace/claudecodeui`
**Commit**: `1f23e41` - Janua OAuth2 integration
**Status**: Ready to push (1 commit ahead of origin/main)

## Quick Push Instructions

### Option 1: GitHub CLI (Recommended - Easiest)

```bash
cd /Users/aldoruizluna/labspace/claudecodeui

# Authenticate with GitHub (one-time)
gh auth login

# Push to fork
git push origin main
```

### Option 2: HTTPS with Personal Access Token

```bash
cd /Users/aldoruizluna/labspace/claudecodeui

# Set remote URL with token
git remote set-url origin https://YOUR_GITHUB_TOKEN@github.com/madfam-org/claudecodeui.git

# Push
git push origin main
```

**Create token**: https://github.com/settings/tokens
**Required scope**: `repo` (Full control of private repositories)

### Option 3: SSH (If Already Configured)

```bash
cd /Users/aldoruizluna/labspace/claudecodeui

# Set remote URL to SSH
git remote set-url origin git@github.com:madfam-org/claudecodeui.git

# Push
git push origin main
```

## Verify Push

After pushing, verify at:
https://github.com/madfam-org/claudecodeui/commits/main

You should see commit `1f23e41` with message:
> feat: Add Janua OAuth2 integration and Auto-Claude agent management

## What's Being Pushed

**10 files changed** (2,669 insertions):
- ✅ `server/utils/janua-client.js` - OAuth2 client wrapper
- ✅ `server/routes/janua-auth.js` - OAuth2 authentication routes
- ✅ `server/middleware/janua-auth.js` - JWT verification middleware
- ✅ `server/services/agentDiscoveryService.js` - K8s + Redis agent discovery
- ✅ `server/services/taskSubmissionService.js` - Redis task queue management
- ✅ `package.json` - Added 3 new dependencies
- ✅ `package-lock.json` - Dependency lock file
- ✅ `.env.example` - Added Janua/K8s/Redis configuration
- ✅ `JANUA_INTEGRATION.md` - 4,000+ line integration guide
- ✅ `MADFAM_INTEGRATION_SUMMARY.md` - Implementation summary

## After Pushing

Once pushed, proceed with **Janua Auth Proxy Docker image push**:

```bash
cd /Users/aldoruizluna/labspace/janua-auth-proxy

# Login to GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u madfam-org --password-stdin

# Push Docker image (already built)
docker push ghcr.io/madfam-org/janua-auth-proxy:latest

# Verify image is accessible
docker pull ghcr.io/madfam-org/janua-auth-proxy:latest
```

## Next: Infrastructure Deployment

After both pushes complete, follow the deployment guide:
`/Users/aldoruizluna/labspace/enclii/AUTOCHESS_DEPLOYMENT.md`

Starting with:
1. Create Kubernetes namespace and secrets
2. Deploy storage infrastructure (100Gi PVC)
3. Deploy Redis coordination layer
4. Deploy Auto-Claude agents with auth sidecar
5. Deploy ClaudeCodeUI frontend
6. Configure Cloudflare Tunnel
7. Test end-to-end authentication
