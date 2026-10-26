import type { NextConfig } from 'next';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // .env is optional when variables are already in the environment.
}

const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';

const config: NextConfig = {
  // The browser only ever talks to the web origin; /api/* is proxied to the Express API.
  // That keeps the auth cookies first-party and avoids cross-origin credentialed requests.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      // Socket.IO (authenticated by the session cookie). Client and server both use the slash-less path
      // "/socket.io" (addTrailingSlash: false) because Next strips trailing slashes before proxying.
      // The UI falls back to polling if the socket is unavailable.
      { source: '/socket.io/:path*', destination: `${apiOrigin}/socket.io/:path*` },
    ];
  },
};

export default config;
