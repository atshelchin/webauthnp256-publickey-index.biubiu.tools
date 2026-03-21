import { marked } from "marked";

// 1. Convert readme.md to index.html
const markdown = await Bun.file("readme.md").text();
const htmlBody = await marked(markdown);
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebAuthn P256 Public Key Index</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown-light.min.css">
<style>
  * { box-sizing: border-box; }
  html { background: #f6f8fa; }
  body {
    max-width: 980px;
    margin: 40px auto;
    padding: 40px 48px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .markdown-body { font-size: 16px; line-height: 1.7; }
  @media (max-width: 767px) {
    body { margin: 16px; padding: 24px 16px; }
  }
</style>
</head>
<body class="markdown-body">${htmlBody}</body>
</html>`;
await Bun.write("src/index.html", html);
console.log("Generated src/index.html");

// 2. Compile to binary
const result = Bun.spawnSync(["bun", "build", "index.ts", "--compile", "--outfile", "dist/webauthnp256-publickey-index"]);
if (result.exitCode !== 0) {
  console.error(result.stderr.toString());
  process.exit(1);
}
console.log(result.stdout.toString());
console.log("Build complete");
