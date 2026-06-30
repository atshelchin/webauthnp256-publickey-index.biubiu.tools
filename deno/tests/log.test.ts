import { assertEquals, assert } from "@std/assert/";
import { redactSecrets } from "../../shared/log.ts";

Deno.test("redactSecrets: strips Alchemy/Infura API key in URL path", () => {
  const url = "https://gnosis-mainnet.g.alchemy.com/v2/AbCdEf123456SecretKey";
  const out = redactSecrets(url);
  assert(!out.includes("AbCdEf123456SecretKey"), "key must be removed");
  assertEquals(out, "https://gnosis-mainnet.g.alchemy.com/v2/***");
});

Deno.test("redactSecrets: strips key/token query params", () => {
  assertEquals(
    redactSecrets("https://rpc.example.com/?apikey=supersecret&foo=bar"),
    "https://rpc.example.com/?apikey=***&foo=bar",
  );
  assertEquals(
    redactSecrets("https://x.io/?access_token=abc123"),
    "https://x.io/?access_token=***",
  );
});

Deno.test("redactSecrets: redacts a key embedded in a viem error message", () => {
  const msg = "HTTP request failed. URL: https://gnosis-mainnet.g.alchemy.com/v2/LEAKEDKEY9999. Status: 500";
  const out = redactSecrets(msg);
  assert(!out.includes("LEAKEDKEY9999"));
  assert(out.includes("/v2/***"));
});

Deno.test("redactSecrets: leaves credential-free strings untouched", () => {
  const s = "batchCreateRecord tx reverted: 0xabc123";
  assertEquals(redactSecrets(s), s);
});
