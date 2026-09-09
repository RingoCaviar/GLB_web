import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3, Vector4 } from 'three';
import { applyVerticalPerspectiveCorrection } from '../src/vertical-lens-shift-core.js';

function project(camera, point) {
  return new Vector3(...point).project(camera);
}

const camera = new PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

camera.setViewOffset(1000, 1000, 0, -250, 1000, 1000);
camera.updateProjectionMatrix();

const center = project(camera, [0, 0, 0]);
const leftBottom = project(camera, [-1, -2, 0]);
const leftTop = project(camera, [-1, 2, 0]);
const rightBottom = project(camera, [1, -2, 0]);
const rightTop = project(camera, [1, 2, 0]);

assert.ok(Math.abs(center.y - -0.5) < 1e-12, '25% 向上取景应使主体中心下移半个 NDC 高度');
assert.ok(Math.abs(leftTop.x - leftBottom.x) < 1e-12, '左侧竖线必须保持平行');
assert.ok(Math.abs(rightTop.x - rightBottom.x) < 1e-12, '右侧竖线必须保持平行');

camera.clearViewOffset();
camera.updateProjectionMatrix();
assert.ok(Math.abs(project(camera, [0, 0, 0]).y) < 1e-12, '清零后必须恢复中心投影');

console.log('vertical lens shift projection tests passed');

const tiltedCamera = new PerspectiveCamera(45, 1, 0.1, 100);
tiltedCamera.position.set(0, 5, 10);
tiltedCamera.lookAt(0, 0, 0);
tiltedCamera.updateMatrixWorld();

const beforeBottom = project(tiltedCamera, [2, -2, 0]);
const beforeTop = project(tiltedCamera, [2, 2, 0]);
assert.notEqual(beforeBottom.x, beforeTop.x, '俯仰相机的竖线应先呈透视收敛');
const orbitBefore = tiltedCamera.matrixWorld.elements.slice();
assert.deepEqual(applyVerticalPerspectiveCorrection(tiltedCamera, true), { applied: true, reason: null });
const depthProbe = new Vector4(-5, -5, -5, 1)
  .applyMatrix4(tiltedCamera.matrixWorldInverse)
  .applyMatrix4(tiltedCamera.projectionMatrix);
assert.ok(depthProbe.z <= depthProbe.w,
  '透视校正不得用失配的远裁剪面截断原本可见的几何体');
const afterBottom = project(tiltedCamera, [2, -2, 0]);
const afterTop = project(tiltedCamera, [2, 2, 0]);
assert.ok(Math.abs(afterBottom.x - afterTop.x) < 1e-12, '校正后同一竖线的 X 坐标必须平行');
assert.deepEqual(tiltedCamera.matrixWorld.elements, orbitBefore, '校正不得改变相机姿态');

console.log('vertical perspective correction projection tests passed');
