import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
createApp(config).listen(config.port, () => {
  console.log(`Harborline IVR listening on :${config.port}  (signing URL base: ${config.publicBaseUrl})`);
});
