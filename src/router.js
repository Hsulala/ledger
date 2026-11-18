// 極簡路由：'/api/c/:cid/purchases/:id' 這種路徑樣式，依 method 比對。
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, options, handler) { routes.push({ method, segments: pattern.split('/').filter(Boolean), options, handler }); },
    match(method, pathname) {
      const parts = pathname.split('/').filter(Boolean);
      for (const route of routes) {
        if (route.method !== method || route.segments.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < parts.length && ok; i += 1) {
          const seg = route.segments[i];
          if (seg.startsWith(':')) { try { params[seg.slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; } } else if (seg !== parts[i]) ok = false;
        }
        if (ok) return { route, params };
      }
      return null;
    },
  };
}
