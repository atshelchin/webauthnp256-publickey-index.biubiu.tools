import { initConfig, getConfig } from "./src/config.ts";
import { initRpc } from "./src/rpc.ts";
import { handleQuery } from "./src/routes/query.ts";
import { handleChallenge } from "./src/routes/challenge.ts";
import { handleCreate, handleCreateStatus } from "./src/routes/create.ts";
import { handleListRpIds, handleListPublicKeys } from "./src/routes/stats.ts";
import { initQueue, startQueueWorker } from "./src/queue.ts";

const HOME_HTML = await Deno.readTextFile(new URL("./src/index.html", import.meta.url));

// Parse CLI args: --port 11256 --private-key 0x... --queue-db queue.db ...
const config = initConfig();
await initRpc();
initQueue(config.queueDbPath);

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

const server = Deno.serve({ port: config.port }, async (req) => {
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
    } else if (path === "/api/challenge" && req.method === "GET") {
      response = handleChallenge();
    } else if (path === "/api/query" && req.method === "GET") {
      response = await handleQuery(req);
    } else if (path === "/api/create" && req.method === "POST") {
      response = await handleCreate(req);
    } else if (path.startsWith("/api/create/") && req.method === "GET") {
      response = handleCreateStatus(req);
    } else if (path === "/api/stats/sites" && req.method === "GET") {
      response = await handleListRpIds(req);
    } else if (path === "/api/stats/keys" && req.method === "GET") {
      response = await handleListPublicKeys(req);
    } else {
      response = Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (error) {
    console.error("Unhandled error:", error);
    response = Response.json({ error: "internal server error" }, { status: 500 });
  }

  return withCors(response);
});

console.log(`Server running at http://localhost:${config.port}`);
startQueueWorker();

export { server };
