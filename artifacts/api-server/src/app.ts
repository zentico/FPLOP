import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { failStaleRuns } from "./lib/solver";
import { failStaleMegas } from "./lib/mega";

failStaleRuns();
failStaleMegas();

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Production/Docker mode: serve the built web app from the same server.
// Set SERVE_WEB_DIR to the fpl-optimizer dist directory.
const webDir = process.env["SERVE_WEB_DIR"];
if (webDir) {
  const express_static = express.static(webDir, { index: "index.html" });
  app.use(express_static);
  // SPA fallback: any non-API GET that didn't match a file gets index.html.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile("index.html", { root: webDir });
  });
}

export default app;
