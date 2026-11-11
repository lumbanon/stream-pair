// Full-screen click-drag selector for the board area.
// Resolves with a viewport rect { left, top, width, height } or null (Esc).
(() => {
  const SP = (globalThis.SP = globalThis.SP || {});
  if (SP.selectArea) return;

  SP.selectArea = function selectArea(parentRoot) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;cursor:crosshair;pointer-events:auto;background:rgba(0,0,0,.25);z-index:2147483647;';
      const hint = document.createElement('div');
      hint.textContent = 'Drag a rectangle around the game board · Esc to cancel';
      hint.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#111;color:#fff;padding:6px 12px;border-radius:6px;font:13px system-ui;pointer-events:none;';
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;border:2px dashed #00e5ff;background:rgba(0,229,255,.08);display:none;pointer-events:none;';
      const size = document.createElement('div');
      size.style.cssText = 'position:absolute;right:0;bottom:-22px;background:#00e5ff;color:#000;font:700 11px system-ui;padding:2px 5px;border-radius:3px;white-space:nowrap;';
      box.append(size);
      wrap.append(hint, box);
      parentRoot.append(wrap);

      let sx = 0, sy = 0, dragging = false;
      const rectFrom = (e) => ({
        left: Math.min(sx, e.clientX), top: Math.min(sy, e.clientY),
        width: Math.abs(e.clientX - sx), height: Math.abs(e.clientY - sy),
      });
      const draw = (r) => {
        Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        const dpr = window.devicePixelRatio || 1;
        size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)} px  (${Math.round(r.width * dpr)} × ${Math.round(r.height * dpr)} device)`;
      };
      const finish = (r) => {
        window.removeEventListener('keydown', onKey, true);
        wrap.remove();
        resolve(r);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };

      wrap.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true; sx = e.clientX; sy = e.clientY;
        e.preventDefault(); e.stopPropagation();
      });
      wrap.addEventListener('mousemove', (e) => { if (dragging) draw(rectFrom(e)); });
      wrap.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        const r = rectFrom(e);
        if (r.width < 20 || r.height < 20) { box.style.display = 'none'; return; }
        finish(r);
      });
      wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); finish(null); });
      window.addEventListener('keydown', onKey, true);
    });
  };
})();
