// #316 mDNS 广播：手表在同一 WiFi 下零配置发现 relay（免手输 IP）。
// 服务类型 _ccdeck._tcp；失败静默（公司网/路由器禁组播不影响其余功能，手表回落手输）
import Bonjour from "bonjour-service";

export function advertiseRelay(port: number, name: string): { stop: () => void } {
  try {
    const bonjour = new Bonjour();
    const service = bonjour.publish({ name, type: "ccdeck", port, txt: { v: "1" } });
    return {
      stop: () => {
        try {
          service.stop();
          bonjour.destroy();
        } catch {}
      },
    };
  } catch {
    return { stop: () => {} };
  }
}
