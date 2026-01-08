/**
 * Janua JWT Authentication Middleware
 * Validates JWT tokens issued by Janua against JWKS endpoint
 */

import * as jose from 'jose';
import fetch from 'node-fetch';

const JANUA_URL = process.env.JANUA_URL || 'https://auth.madfam.io';
const JWKS_CACHE_DURATION = 3600 * 1000; // 1 hour

let jwksCache = null;
let jwksCacheTime = 0;

/**
 * Fetch and cache JWKS from Janua
 * @returns {Promise<jose.JSONWebKeySet>}
 */
async function getJWKS() {
  const now = Date.now();

  // Return cached JWKS if still valid
  if (jwksCache && (now - jwksCacheTime) < JWKS_CACHE_DURATION) {
    return jwksCache;
  }

  try {
    const response = await fetch(`${JANUA_URL}/.well-known/jwks.json`);
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }

    jwksCache = await response.json();
    jwksCacheTime = now;

    console.log('✅ JWKS fetched and cached from Janua');
    return jwksCache;
  } catch (error) {
    console.error('❌ Failed to fetch JWKS:', error);

    // Return stale cache if available
    if (jwksCache) {
      console.warn('⚠️  Using stale JWKS cache');
      return jwksCache;
    }

    throw error;
  }
}

/**
 * Verify JWT token issued by Janua
 * @param {string} token - JWT token
 * @returns {Promise<Object>} Decoded and verified token payload
 */
async function verifyJanuaToken(token) {
  const jwks = await getJWKS();
  const JWKS = jose.createRemoteJWKSet(new URL(`${JANUA_URL}/.well-known/jwks.json`));

  try {
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: JANUA_URL,
      audience: process.env.JANUA_CLIENT_ID
    });

    return payload;
  } catch (error) {
    console.error('JWT verification failed:', error.message);
    throw new Error('Invalid or expired token');
  }
}

/**
 * Middleware: Authenticate requests with Janua JWT tokens
 * Validates Bearer token in Authorization header against Janua JWKS
 */
export const authenticateJanuaToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      hint: 'Include "Authorization: Bearer <token>" header'
    });
  }

  try {
    // Verify token against Janua JWKS
    const payload = await verifyJanuaToken(token);

    // Attach user info to request
    req.user = {
      id: payload.sub,
      username: payload.sub,
      email: payload.email,
      name: payload.name,
      scopes: payload.scope ? payload.scope.split(' ') : []
    };

    next();
  } catch (error) {
    console.error('Janua token verification error:', error);
    return res.status(403).json({
      error: 'Invalid or expired token',
      details: error.message
    });
  }
};

/**
 * Middleware: Require specific OAuth2 scope
 * @param {string} requiredScope - Required OAuth2 scope (e.g., 'agent:control')
 */
export const requireScope = (requiredScope) => {
  return (req, res, next) => {
    const userScopes = req.user?.scopes || [];

    if (!userScopes.includes(requiredScope)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required_scope: requiredScope,
        user_scopes: userScopes
      });
    }

    next();
  };
};

/**
 * Middleware: Authenticate with either Janua JWT or local JWT
 * Falls back to local JWT if Janua verification fails
 */
export const authenticateFlexible = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    // Try Janua JWT verification first
    const payload = await verifyJanuaToken(token);
    req.user = {
      id: payload.sub,
      username: payload.sub,
      email: payload.email,
      name: payload.name,
      scopes: payload.scope ? payload.scope.split(' ') : [],
      auth_provider: 'janua'
    };
    return next();
  } catch (januaError) {
    // Fall back to local JWT verification
    try {
      const { authenticateToken } = await import('./auth.js');
      return authenticateToken(req, res, next);
    } catch (localError) {
      console.error('Both Janua and local JWT verification failed');
      return res.status(403).json({ error: 'Invalid token' });
    }
  }
};

export default {
  authenticateJanuaToken,
  requireScope,
  authenticateFlexible,
  verifyJanuaToken
};
