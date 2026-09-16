import { captureConsoleBottom } from "../src/injector.js";
const pid = Number(process.argv[2]);
for (let i = 0; i < 2; i++) {
  const rows = await captureConsoleBottom(pid, 6);
  console.log("rows:", JSON.stringify(rows));
  await new Promise((r) => setTimeout(r, 1000));
}
