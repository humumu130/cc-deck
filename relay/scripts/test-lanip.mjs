// #25 lan-ip 探测单测：模拟网卡清单覆盖环境敏感分支（含用户公司机形态）。
// node relay/scripts/test-lanip.mjs
import { detectLanIp, VIRTUAL_NIC_RE } from "../src/lan-ip.ts";

let pass = 0, fail = 0;
const t = (name, ifs, want) => {
  const got = detectLanIp(ifs);
  if (got === want) { pass++; console.log("ok - " + name); }
  else { fail++; console.log(`FAIL: ${name} → got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};

t("物理网卡普通家用（我机形态）", { "以太网": [{ family: "IPv4", address: "192.168.0.101" }] }, "192.168.0.101");
t("#25 用户公司机形态：宿主网只在 vEthernet（Hyper-V/WSL2）", {
  "vEthernet (默认交换机)": [{ family: "IPv4", address: "10.123.90.5" }],
  "Loopback Pseudo-Interface 1": [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
}, "10.123.90.5");
t("物理+虚拟并存：优先物理", {
  "vEthernet (Hyper-V)": [{ family: "IPv4", address: "172.18.0.1" }],
  "以太网": [{ family: "IPv4", address: "10.0.0.5" }],
}, "10.0.0.5");
t("回退段仍排除回环/链路本地/公网", {
  "Loopback": [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
  "WiFi": [{ family: "IPv4", address: "169.254.1.2" }, { family: "IPv6", address: "fe80::1" }],
  "公网网卡": [{ family: "IPv4", address: "8.8.8.8" }],
}, "");
t("VPN-only（Tailscale 100.64 CGNAT 不算私网）", {
  "Tailscale": [{ family: "IPv4", address: "100.64.0.1" }],
}, "");
t("多地址网卡取第一个私网", {
  "Wi-Fi": [{ family: "IPv4", address: "10.5.5.5" }, { family: "IPv4", address: "192.168.1.1" }],
}, "10.5.5.5");
t("172.16-31 段识别", { "eth0": [{ family: "IPv4", address: "172.20.3.4" }] }, "172.20.3.4");
t("172.32（非私网）排除", { "eth0": [{ family: "IPv4", address: "172.32.0.1" }] }, "");

console.log(fail ? `LAN-IP TESTS FAILED (${fail})` : "LAN-IP TESTS PASSED");
process.exit(fail ? 1 : 0);
