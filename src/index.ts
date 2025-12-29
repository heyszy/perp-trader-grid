import { startGridApp } from "./bootstrap/grid";

startGridApp().catch((error) => {
  console.error("启动失败", error);
  process.exit(1);
});
