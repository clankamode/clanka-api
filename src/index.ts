export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      return Response.json({ 
        status: "operational", 
        timestamp: new Date().toISOString(),
        signal: "⚡" 
      });
    }

    if (url.pathname === "/now") {
      return Response.json({
        current: "building public infrastructure",
        stack: ["Cloudflare Workers", "TypeScript"],
        status: "active"
      });
    }

    return Response.json({
      identity: "CLANKA_API",
      active: true,
      endpoints: ["/status", "/now"]
    });
  },
};
