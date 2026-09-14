import * as THREE from 'three'

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vec3 n = mat3(modelMatrix) * normal;
    // у сканов попадаются вырожденные треугольники; normalize(vec3(0)) даёт NaN,
    // а mipmap-блюр Bloom разносит его по всему кадру
    vWorldNormal = dot(n, n) > 1e-12 ? normalize(n) : vec3(0.0, 1.0, 0.0);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3  uColor;
  uniform vec3  uEdgeColor;
  uniform float uOpacity;
  uniform float uAssemble;   // 0 — пусто, 1 — материализовано
  uniform float uHighlight;  // подсветка гнезда, куда можно вставить черепок
  uniform float uGridScale;
  uniform float uGridStrength;
  uniform float uMinY;
  uniform float uHeight;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  vec3 safeNormal(vec3 n) {
    return dot(n, n) > 1e-12 ? normalize(n) : vec3(0.0, 1.0, 0.0);
  }

  float gridAt(vec2 c) {
    vec2 w = fwidth(c);
    vec2 r = abs(fract(c - 0.5) - 0.5) / max(w, vec2(1e-5));
    return 1.0 - min(min(r.x, r.y), 1.0);
  }

  float triGrid(vec3 n) {
    vec3 an = abs(n);
    float g = gridAt(vWorldPos.yz * uGridScale) * an.x
            + gridAt(vWorldPos.xz * uGridScale) * an.y
            + gridAt(vWorldPos.xy * uGridScale) * an.z;
    return g / max(an.x + an.y + an.z, 0.001);
  }

  void main() {
    vec3 N = safeNormal(vWorldNormal);
    vec3 V = safeNormal(cameraPosition - vWorldPos);
    float fres = pow(max(1.0 - abs(dot(N, V)), 1e-5), 2.1);

    // сетка только к силуэту: в лицо поверхность остаётся чистым стеклом
    float grid = triGrid(N) * smoothstep(0.04, 0.46, fres);

    // сканлайны и медленная волна снизу вверх
    float lines = smoothstep(0.5, 1.0, sin((vWorldPos.y - uTime * 0.5) * 40.0)) * 0.12;
    float sweepY = uMinY + fract(uTime * 0.12) * uHeight * 1.2 - uHeight * 0.1;
    float sweepD = (vWorldPos.y - sweepY) / (uHeight * 0.04);
    float sweep = exp(-sweepD * sweepD) * 0.45;

    // материализация: вспышка по фронту появления
    float birthD = (uAssemble - 0.5) * 2.4;
    float birth = exp(-birthD * birthD) * step(uAssemble, 0.999);

    float pulse = uHighlight * (0.45 + 0.55 * sin(uTime * 4.5)) * 0.7;

    float alpha = 0.10 + fres * 0.55 + lines + sweep * 0.5
                + grid * uGridStrength * 3.0 + birth * 0.45 + pulse;
    alpha = clamp(alpha * uAssemble * uOpacity, 0.0, 1.0);

    float hot = clamp(fres * 0.8 + sweep + birth * 0.9 + pulse, 0.0, 1.0);
    vec3 col = mix(uColor, uEdgeColor, hot * 0.7) * (0.8 + hot * 1.6);

    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`

export type HologramUniforms = {
  uTime: { value: number }
  uColor: { value: THREE.Color }
  uEdgeColor: { value: THREE.Color }
  uOpacity: { value: number }
  uAssemble: { value: number }
  uHighlight: { value: number }
  uGridScale: { value: number }
  uGridStrength: { value: number }
  uMinY: { value: number }
  uHeight: { value: number }
}

export function createHologramMaterial(color = '#1ec8ff', edge = '#dcfbff') {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uEdgeColor: { value: new THREE.Color(edge) },
      uOpacity: { value: 1 },
      uAssemble: { value: 1 },
      uHighlight: { value: 0 },
      uGridScale: { value: 3.4 },
      uGridStrength: { value: 0.22 },
      uMinY: { value: 0 },
      uHeight: { value: 3 },
    } satisfies HologramUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  })
  return material as THREE.ShaderMaterial & { uniforms: HologramUniforms }
}
