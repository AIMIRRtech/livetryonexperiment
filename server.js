const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 5000;
const rootDir = __dirname;

// Serve GLB — try binary file first, fall back to base64 embedded in JS module
let glbBuffer = null;
try {
  const raw = fs.readFileSync(path.join(rootDir, "assets/virtualtryon.glb"));
  if (raw.length > 100) glbBuffer = raw;
} catch {}
if (!glbBuffer) {
  try {
    const b64 = require("./glb-data");
    glbBuffer = Buffer.from(b64, "base64");
    console.log("GLB loaded from glb-data.js:", glbBuffer.length, "bytes");
  } catch (e) {
    console.error("No GLB source available:", e.message);
  }
}

// Serve GLB via explicit route to bypass static file issues
app.get("/assets/virtualtryon.glb", (req, res) => {
  if (glbBuffer) {
    res.setHeader("Content-Type", "model/gltf-binary");
    res.setHeader("Content-Length", glbBuffer.length);
    res.send(glbBuffer);
  } else {
    res.status(404).send("GLB not found");
  }
});
app.get("/assets/jacket-model.dat", (req, res) => {
  if (glbBuffer) {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", glbBuffer.length);
    res.send(glbBuffer);
  } else {
    res.status(404).send("GLB not found");
  }
});

// Product GLBs no longer needed — color swapping on the client uses the same red jacket mesh

app.use(
  express.static(rootDir, {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".glb") res.setHeader("Content-Type", "model/gltf-binary");
      else if (ext === ".js") res.setHeader("Content-Type", "application/javascript");
      else if (ext === ".svg") res.setHeader("Content-Type", "image/svg+xml");
      else if (ext === ".css") res.setHeader("Content-Type", "text/css");
    },
  })
);

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.listen(port, () => {
  console.log(`AIMIRR Try-On Widget running on port ${port}`);
});
