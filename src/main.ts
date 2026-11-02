import path from "node:path";
import { initialize } from "./init.js";
import { startManaged } from "./application.js";
const root = path.resolve(process.env.HINENI_ROOT ?? process.cwd());
if (process.argv[2] === "init") {
  await initialize(root);
  console.log(
    "Initialized. Configure credentials and channels in the control panel.",
  );
} else {
  const service = await startManaged(root);
  console.log(
    `Hineni API http://${service.app.runtime.cfg.server.host}:${service.app.runtime.cfg.server.port}; admin http://${service.app.runtime.cfg.server.host}:${service.app.runtime.cfg.server.adminPort}`,
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void service
        .close()
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(String(e));
          process.exit(1);
        });
    });
}
