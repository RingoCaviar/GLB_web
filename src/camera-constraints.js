const MIN_POSITIVE_DISTANCE = 1e-9;

export function orbitDirection(thetaDegrees, phiDegrees) {
  const theta = thetaDegrees * Math.PI / 180;
  const phi = phiDegrees * Math.PI / 180;
  const sinPhi = Math.sin(phi);
  return {
    x: sinPhi * Math.sin(theta),
    y: Math.cos(phi),
    z: sinPhi * Math.cos(theta),
  };
}

export function createBounds(center, dimensions) {
  const half = {
    x: Math.abs(dimensions.x) / 2,
    y: Math.abs(dimensions.y) / 2,
    z: Math.abs(dimensions.z) / 2,
  };
  return {
    min: { x: center.x - half.x, y: center.y - half.y, z: center.z - half.z },
    max: { x: center.x + half.x, y: center.y + half.y, z: center.z + half.z },
    diagonal: Math.hypot(dimensions.x, dimensions.y, dimensions.z),
  };
}

function boundsEpsilon(bounds) {
  return Number.isFinite(bounds?.diagonal) && bounds.diagonal > 0
    ? Math.max(bounds.diagonal * 1e-4, MIN_POSITIVE_DISTANCE)
    : MIN_POSITIVE_DISTANCE;
}

export function pointInsideBounds(bounds, point, margin = 0) {
  if (!bounds || !point || !Number.isFinite(margin)) return false;
  return ['x', 'y', 'z'].every((axis) =>
    Number.isFinite(bounds.min?.[axis]) &&
    Number.isFinite(bounds.max?.[axis]) &&
    Number.isFinite(point[axis]) &&
    point[axis] >= bounds.min[axis] - margin &&
    point[axis] <= bounds.max[axis] + margin);
}

export function rayBoundsInterval({ bounds, target, theta, phi }) {
  if (!bounds || !target || ![theta, phi].every(Number.isFinite)) return null;
  const direction = orbitDirection(theta, phi);
  let entry = -Infinity;
  let exit = Infinity;

  for (const axis of ['x', 'y', 'z']) {
    const origin = target[axis];
    const minimum = bounds.min?.[axis];
    const maximum = bounds.max?.[axis];
    const component = direction[axis];
    if (![origin, minimum, maximum, component].every(Number.isFinite) || minimum > maximum) {
      return null;
    }
    if (Math.abs(component) < Number.EPSILON) {
      if (origin < minimum || origin > maximum) return null;
      continue;
    }
    let near = (minimum - origin) / component;
    let far = (maximum - origin) / component;
    if (near > far) [near, far] = [far, near];
    entry = Math.max(entry, near);
    exit = Math.min(exit, far);
    if (entry > exit) return null;
  }

  if (!Number.isFinite(exit) || exit < 0) return null;
  return {
    entry: Math.max(0, entry),
    exit,
    epsilon: boundsEpsilon(bounds),
    originInside: pointInsideBounds(bounds, target),
  };
}

export function surfaceRadius({ bounds, target, theta, phi }) {
  const interval = rayBoundsInterval({ bounds, target, theta, phi });
  const epsilon = boundsEpsilon(bounds);
  return interval?.originInside ? Math.max(interval.exit + epsilon, epsilon) : epsilon;
}

export function resolveSafeRadius({ bounds, target, theta, phi, radius, previousRadius = radius }) {
  if (!Number.isFinite(radius) || radius <= 0) {
    return { radius, minimumRadius: boundsEpsilon(bounds), corrected: false, interval: null };
  }
  const interval = rayBoundsInterval({ bounds, target, theta, phi });
  const epsilon = interval?.epsilon ?? boundsEpsilon(bounds);
  if (!interval) {
    return { radius: Math.max(radius, epsilon), minimumRadius: epsilon, corrected: radius < epsilon, interval };
  }
  if (interval.originInside) {
    const minimumRadius = Math.max(interval.exit + epsilon, epsilon);
    return {
      radius: Math.max(radius, minimumRadius),
      minimumRadius,
      corrected: radius < minimumRadius,
      interval,
    };
  }

  const nearLimit = Math.max(epsilon, interval.entry - epsilon);
  const farLimit = interval.exit + epsilon;
  const previous = Number.isFinite(previousRadius) && previousRadius > 0 ? previousRadius : radius;
  let safeRadius = radius;

  // Keep continuous movement on its current side of the model. This also
  // blocks a single large wheel/input step from tunnelling through the box.
  if (previous >= farLimit && radius < farLimit) safeRadius = farLimit;
  else if (previous <= nearLimit && radius > nearLimit) safeRadius = nearLimit;
  else if (radius > nearLimit && radius < farLimit) {
    safeRadius = radius - nearLimit <= farLimit - radius ? nearLimit : farLimit;
  }

  return {
    radius: safeRadius,
    minimumRadius: epsilon,
    corrected: safeRadius !== radius,
    interval: { ...interval, nearLimit, farLimit },
  };
}

export function framingInvariant(radius, fov) {
  return radius * Math.tan(fov * Math.PI / 360);
}

export function resolveFovChange({ radius, fov, requestedFov, minimumRadius }) {
  if (![radius, fov, requestedFov, minimumRadius].every(Number.isFinite) ||
      radius <= 0 || fov <= 0 || requestedFov <= 0 || minimumRadius <= 0) {
    return { radius, fov, limited: false };
  }

  const invariant = framingInvariant(radius, fov);
  const requestedRadius = invariant / Math.tan(requestedFov * Math.PI / 360);
  if (requestedRadius >= minimumRadius) {
    return { radius: requestedRadius, fov: requestedFov, limited: false };
  }

  const reachableFov = 2 * Math.atan(invariant / minimumRadius) * 180 / Math.PI;
  return {
    radius: minimumRadius,
    fov: Math.min(requestedFov, reachableFov),
    limited: true,
  };
}
