import { initDb } from "./src/db.ts";
import { handleQuery } from "./src/routes/query.ts";
import { handleChallenge, handleCreate } from "./src/routes/create.ts";
import { handleListRpIds, handleListPublicKeys } from "./src/routes/stats.ts";
import { handleBackup, handleRestore, startAutoBackup } from "./src/routes/maintain.ts";
import HOME_HTML from "./src/index.html" with { type: "text" };

initDb(process.env.DB_PATH || "data.db");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

const server = Bun.serve({
  port: parseInt(process.env.PORT || "11256", 10),
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(req.url);
    const path = url.pathname;

    let response: Response;

    try {
      if (path === "/" && req.method === "GET") {
        response = new Response(HOME_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } else if (path === "/api/health" && req.method === "GET") {
        response = Response.json({ status: "ok" });
      } else if (path === "/api/query" && req.method === "GET") {
        response = handleQuery(req);
      } else if (path === "/api/challenge" && req.method === "GET") {
        response = handleChallenge();
      } else if (path === "/api/create" && req.method === "POST") {
        response = await handleCreate(req);
      } else if (path === "/api/stats/sites" && req.method === "GET") {
        response = handleListRpIds(req);
      } else if (path === "/api/stats/keys" && req.method === "GET") {
        response = handleListPublicKeys(req);
      } else if (path === "/api/backup" && req.method === "POST") {
        response = await handleBackup();
      } else if (path === "/api/restore" && req.method === "POST") {
        response = await handleRestore(req);
      } else {
        response = Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      console.error("Unhandled error:", error);
      response = Response.json({ error: "internal server error" }, { status: 500 });
    }

    return withCors(response);
  },
});

console.log(`Server running at http://localhost:${server.port}`);
startAutoBackup();

export { server };
