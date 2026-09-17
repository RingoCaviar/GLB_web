import assert from 'node:assert/strict';
import { filterLibraryItems } from '../src/library-search.js';

const items = [
  { id: 'medical/Injector Box.glb', name: 'Injector Box', folderPath: 'medical' },
  { id: '包装/注射器.glb', name: '注射器', folderPath: '包装' },
  { id: 'furniture/chair.glb', name: 'Chair', folderPath: 'furniture' },
];

assert.deepEqual(
  filterLibraryItems(items, 'injector box').map((item) => item.id),
  ['medical/Injector Box.glb'],
  '搜索应忽略英文大小写并支持多关键词',
);

assert.deepEqual(
  filterLibraryItems(items, '包装 注射').map((item) => item.id),
  ['包装/注射器.glb'],
  '搜索应同时匹配名称与目录路径',
);

assert.equal(filterLibraryItems(items, '   '), items, '空搜索应保留原列表引用');
assert.deepEqual(filterLibraryItems(items, '不存在'), [], '无匹配时应返回空列表');

console.log('库内搜索测试通过');
