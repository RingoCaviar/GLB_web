import {
  LinearFilter,
  LinearMipmapLinearFilter,
} from 'three';
import {
  $renderer,
  $scene,
} from '@google/model-viewer/lib/model-viewer-base.js';

const EXPECTED_MODEL_VIEWER_VERSION = '4.3.1';
const textureRegistry = new WeakMap();

export function resetTextureQuality(viewer) {
  textureRegistry.delete(viewer);
}

function getModelTextures(viewer) {
  const scene = viewer[$scene];
  if (!scene?.traverse) return [];
  const textures = new Set();
  scene.traverse((object) => {
    const materials = Array.isArray(object.material)
      ? object.material
      : object.material ? [object.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });
  return [...textures];
}

function applyPublicSamplerFallback(viewer) {
  const textures = new Set();
  for (const material of viewer.model?.materials ?? []) {
    for (const value of Object.values(material)) {
      const texture = value?.texture;
      if (texture?.sampler) textures.add(texture);
    }
    const pbr = material.pbrMetallicRoughness;
    for (const info of [pbr?.baseColorTexture, pbr?.metallicRoughnessTexture]) {
      if (info?.texture?.sampler) textures.add(info.texture);
    }
  }
  for (const texture of textures) {
    texture.sampler.setMinFilter(LinearMipmapLinearFilter);
    texture.sampler.setMagFilter(LinearFilter);
  }
  return textures.size;
}

/**
 * Applies the best texture sampling supported by the active GPU. This module is
 * deliberately isolated because the anisotropy hook is version-coupled to
 * model-viewer 4.3.1; the public scene graph remains the safe fallback.
 */
export function applyMaximumTextureQuality(viewer) {
  const fallbackTextureCount = applyPublicSamplerFallback(viewer);
  try {
    const renderer = viewer[$renderer]?.threeRenderer;
    const scene = viewer[$scene];
    if (!renderer?.capabilities || !scene?.traverse) {
      throw new Error('COMPATIBILITY_API_UNAVAILABLE');
    }

    const maximumAnisotropy = Math.max(
      1,
      Number(renderer.capabilities.getMaxAnisotropy?.()) || 1,
    );
    const textures = getModelTextures(viewer);

    for (const texture of textures) {
      texture.anisotropy = maximumAnisotropy;
      texture.generateMipmaps = true;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.needsUpdate = true;
    }
    textureRegistry.set(viewer, textures);
    scene.queueRender();
    return {
      applied: textures.length > 0,
      compatibility: true,
      maximumAnisotropy,
      textureCount: textures.length,
      expectedVersion: EXPECTED_MODEL_VIEWER_VERSION,
    };
  } catch (error) {
    return {
      applied: fallbackTextureCount > 0,
      compatibility: false,
      maximumAnisotropy: 1,
      textureCount: fallbackTextureCount,
      expectedVersion: EXPECTED_MODEL_VIEWER_VERSION,
      error,
    };
  }
}

/**
 * Temporarily locks model textures to their full-resolution base level. This is
 * intended for still-image export: avoiding lower mip levels improves oblique
 * detail, while the normal trilinear preview remains the stable default.
 */
export function beginExportTextureDetail(viewer, mode = 'base-level') {
  if (mode !== 'base-level') {
    return { applied: false, mode: 'adaptive', textureCount: 0, restore() {} };
  }

  const scene = viewer[$scene];
  const textures = textureRegistry.get(viewer) ?? getModelTextures(viewer);
  if (!scene?.queueRender || textures.length === 0) {
    return { applied: false, mode: 'base-level', textureCount: 0, restore() {} };
  }

  const snapshots = textures.map((texture) => ({
    texture,
    minFilter: texture.minFilter,
    magFilter: texture.magFilter,
    anisotropy: texture.anisotropy,
    generateMipmaps: texture.generateMipmaps,
  }));
  let restored = false;

  for (const { texture } of snapshots) {
    // LinearFilter is a non-mipmapped filter, so WebGL samples level zero while
    // retaining the already-created mip chain for restoration after export.
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.needsUpdate = true;
  }
  scene.queueRender();

  return {
    applied: true,
    mode: 'base-level',
    textureCount: snapshots.length,
    restore() {
      if (restored) return;
      restored = true;
      for (const snapshot of snapshots) {
        Object.assign(snapshot.texture, {
          minFilter: snapshot.minFilter,
          magFilter: snapshot.magFilter,
          anisotropy: snapshot.anisotropy,
          generateMipmaps: snapshot.generateMipmaps,
          needsUpdate: true,
        });
      }
      scene.queueRender();
    },
  };
}
