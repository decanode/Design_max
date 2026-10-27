// The browser talks only to this origin; Next forwards API + Socket.io traffic to the API server.
// This avoids CORS and the need to expose/forward a second port (e.g. in Codespaces).
const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

export default {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true, // Socket.io requests end in "/"
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      // Next strips the trailing slash that engine.io requires, so restore it explicitly.
      { source: '/socket.io', destination: `${api}/socket.io/` },
      { source: '/socket.io/:path+', destination: `${api}/socket.io/:path+` },
    ];
  },
};
