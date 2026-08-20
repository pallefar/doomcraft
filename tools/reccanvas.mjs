// Record a page's WebGL canvas at true 60fps from inside the page.
// Playwright's own recordVideo does not capture accelerated canvases (it yields ~2KB of nothing),
// so we use canvas.captureStream() + MediaRecorder and pull the blob out as base64.
//
// Exported for use by capture-ref.mjs / capture-ours.mjs.
export async function recordCanvas(page, seconds, drive) {
  await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) throw new Error('no canvas');
    const stream = c.captureStream(60);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('no MediaRecorder support');
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    window.__chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) window.__chunks.push(e.data); };
    rec.start(200);
    window.__rec = rec;
  });
  if (drive) await drive();
  else await page.waitForTimeout(seconds * 1000);
  const b64 = await page.evaluate(async () => {
    const rec = window.__rec;
    await new Promise((res) => { rec.onstop = res; rec.stop(); });
    const blob = new Blob(window.__chunks, { type: 'video/webm' });
    const buf = await blob.arrayBuffer();
    let s = ''; const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}
