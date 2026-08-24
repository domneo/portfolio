/*!
 * CRT tube — the whole page, rendered through a fragment shader.
 *
 * Chrome's HTML-in-canvas API (`<canvas layoutsubtree>` +
 * `ctx.drawElementImage()`) paints a live DOM subtree into a 2D canvas
 * every frame. That canvas becomes a WebGL texture, a CRT shader runs
 * over it, and the result is drawn on a second canvas stacked on top
 * with `pointer-events: none` — so the real DOM underneath still takes
 * clicks, focus, Tab, scroll and selection. Nothing is a screenshot.
 *
 * The API sits behind chrome://flags/#enable-html-in-canvas. Everything
 * here is opt-in on feature detection: if the flag is off, if WebGL is
 * missing, or if the shader fails to build, the page is left exactly as
 * authored and renders normally.
 */
(() => {
  "use strict";

  const page = document.getElementById("crt-page");
  if (!page) return;

  // --- feature detection -----------------------------------------------------
  const Ctx2D = window.CanvasRenderingContext2D;
  if (!Ctx2D || !("drawElementImage" in Ctx2D.prototype)) return;

  const staging = document.createElement("canvas");
  staging.id = "crt-staging";
  // Lays the child DOM out for real, at the canvas bitmap's size.
  staging.setAttribute("layoutsubtree", "");

  const output = document.createElement("canvas");
  output.id = "crt-output";
  output.setAttribute("aria-hidden", "true");

  const ctx = staging.getContext("2d");
  const gl = output.getContext("webgl", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    antialias: false,
  });
  if (!ctx || !gl) return;

  // --- shaders ---------------------------------------------------------------
  const VERT = `
attribute vec2 a_position;
varying vec2 v_texCoord;
void main() {
  v_texCoord = a_position * 0.5 + 0.5;
  /* The staging bitmap is top-down; GL textures are bottom-up. */
  v_texCoord.y = 1.0 - v_texCoord.y;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const FRAG = `
precision mediump float;

uniform sampler2D u_texture;
uniform vec2  u_css;     /* size of the tube, in CSS px */
uniform float u_time;    /* seconds since boot */
uniform float u_motion;  /* 1 = animate, 0 = prefers-reduced-motion */

varying vec2 v_texCoord;

const float CURVE    = 0.055;  /* barrel distortion of the glass */
const float SCAN     = 0.15;   /* scanline depth */
const float MASK     = 0.05;   /* aperture-grille depth */
const float BLOOM    = 0.55;   /* phosphor halo around bright strokes */
const float VIGNETTE = 0.5;

vec3 tap(vec2 uv) { return texture2D(u_texture, uv).rgb; }

void main() {
  vec2 dc = v_texCoord - 0.5;
  float d2 = dot(dc, dc);

  /* Curvature: the corners of a tube sit further from the gun. */
  vec2 uv = v_texCoord + dc * d2 * CURVE;

  /* Tracking drift — a fraction of a pixel, so the image never sits
     perfectly still without ever being hard to read. */
  uv.x += u_motion * sin(uv.y * 90.0 + u_time * 1.7) * 0.00035;

  vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  float inside = inb.x * inb.y;

  vec3 col = tap(uv);

  /* Bloom: only where the neighbours are brighter than this pixel, so
     glyph edges glow and filled areas are left alone. One CSS pixel of
     reach, whatever the capture's device density. */
  vec2 texel = 1.0 / u_css;
  vec3 near = tap(uv + vec2(texel.x, 0.0))
            + tap(uv - vec2(texel.x, 0.0))
            + tap(uv + vec2(0.0, texel.y))
            + tap(uv - vec2(0.0, texel.y));
  col += max(near * 0.25 - col, vec3(0.0)) * BLOOM;

  /* Scanlines — one dark band every two CSS pixels. */
  float scan = 0.5 + 0.5 * cos(uv.y * u_css.y * 3.14159265);
  col *= 1.0 - SCAN * scan;

  /* Aperture grille — RGB triads, one CSS pixel wide. */
  float phase = mod(floor(uv.x * u_css.x), 3.0);
  vec3 grille = vec3(1.0 - MASK);
  if (phase < 1.0)      grille.r = 1.0 + MASK * 2.0;
  else if (phase < 2.0) grille.g = 1.0 + MASK * 2.0;
  else                  grille.b = 1.0 + MASK * 2.0;
  col *= grille;

  /* Refresh flicker, plus a slow roll bar drifting up the screen. */
  col *= 1.0 - u_motion * 0.02 * (0.5 + 0.5 * sin(u_time * 7.3));
  float bar = fract(v_texCoord.y * 0.5 - u_time * 0.06);
  col *= 1.0 - u_motion * 0.03 * smoothstep(0.07, 0.0, bar);

  /* Vignette, then the bezel: everything the curve pushed off-glass. */
  col *= 1.0 - d2 * VIGNETTE;

  gl_FragColor = vec4(clamp(col * inside, 0.0, 1.0), 1.0);
}`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("[crt] shader:", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = vs && compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[crt] link:", gl.getProgramInfoLog(program));
    return;
  }

  const aPosition = gl.getAttribLocation(program, "a_position");
  const uTexture = gl.getUniformLocation(program, "u_texture");
  const uCss = gl.getUniformLocation(program, "u_css");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uMotion = gl.getUniformLocation(program, "u_motion");

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // --- mount -----------------------------------------------------------------
  // Only now, with a working pipeline, does the page move inside the canvas.
  document.documentElement.classList.add("crt-on");
  document.body.append(staging, output);
  staging.append(page);

  // Layout of the subtree follows the canvas's CSS box; the bitmap only sets
  // how finely it is painted. So both canvases run at device density and the
  // page still lays out in ordinary CSS pixels.
  let cssW = 0;
  let cssH = 0;

  function syncSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = Math.max(1, staging.clientWidth);
    cssH = Math.max(1, staging.clientHeight);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);

    if (staging.width !== w || staging.height !== h) {
      staging.width = w;
      staging.height = h;
      staging.requestPaint?.();
    }
    if (output.width !== w || output.height !== h) {
      output.width = w;
      output.height = h;
    }
  }

  staging.onpaint = () => {
    ctx.clearRect(0, 0, staging.width, staging.height);
    try {
      // The returned transform maps the captured subtree back onto the
      // page, keeping the live DOM's hit box under what you can see.
      const t = ctx.drawElementImage(page, 0, 0);
      if (t) page.style.transform = t.toString();
    } catch {
      /* "No cached paint record" — the next frame resamples. */
    }
  };

  // --- render loop -----------------------------------------------------------
  const stillness = matchMedia("(prefers-reduced-motion: reduce)");
  const start = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);

    syncSize();
    // Re-capture every frame: the blinking cursor, hover states, focus
    // rings and scrolling all have to reach the texture.
    staging.requestPaint?.();

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      staging,
    );

    gl.viewport(0, 0, output.width, output.height);
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uTexture, 0);
    gl.uniform2f(uCss, cssW, cssH);
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform1f(uMotion, stillness.matches ? 0 : 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  requestAnimationFrame(frame);
})();
