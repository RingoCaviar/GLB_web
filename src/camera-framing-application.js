export function applyBuildingCorrection(framing) {
  return { ...framing, phi: 90 };
}

export async function applyViewerCameraFraming(viewer, framing, {
  immediate = false,
  applyProjection = () => {},
} = {}) {
  const radius = framing.radius === 'auto' ? 'auto' : `${framing.radius}m`;
  viewer.cameraOrbit = `${framing.theta}deg ${framing.phi}deg ${radius}`;
  viewer.fieldOfView = `${framing.fov}deg`;
  await viewer.updateComplete;
  if (immediate) viewer.jumpCameraToGoal();
  applyProjection(viewer, framing);
}
