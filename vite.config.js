import { defineConfig } from 'vite';
import { modelMetadataPlugin } from './scripts/model-metadata-plugin.mjs';
import { thumbnailPlugin } from './scripts/thumbnail-middleware.mjs';
import { sequencePlugin } from './scripts/sequence-middleware.mjs';
import { lightingDefaultPlugin } from './scripts/lighting-default-middleware.mjs';
import { environmentManifestPlugin } from './scripts/environment-manifest-plugin.mjs';

export default defineConfig({
  plugins: [environmentManifestPlugin(), modelMetadataPlugin(), thumbnailPlugin(), sequencePlugin(), lightingDefaultPlugin()],
  server: {
    watch: {
      // Generated covers are refreshed by the page from the save response.
      // Ignoring them prevents a thumbnail write from reloading the studio.
      ignored: ['**/*.cover.webp'],
    },
  },
});
