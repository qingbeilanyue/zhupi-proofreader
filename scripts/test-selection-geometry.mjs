import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/model.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { calloutSize, defaultSourceFrame, deletionTailSegments, insertionAnchor, insertionFork, leaderEndpoints, mergeSelectionRects, pageTextMetrics, positionMarkStrokes, sourceFrames } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const width = 600;
const height = 800;
const glyph = (x, y, w = 11, h = 18) => ({ x: x / width, y: y / height, width: w / width, height: h / height });
const chineseLine = Array.from({ length: 10 }, (_, index) => glyph(50 + index * 12, 240));

const oneLine = mergeSelectionRects(chineseLine, width, height);
assert.equal(oneLine.length, 1, '连续中文字应合成一处圈选');
assert.ok(Math.abs(oneLine[0].width * width - 119) < .01, '应覆盖整段文字');

const twoLines = mergeSelectionRects([...chineseLine, ...chineseLine.map((item) => ({ ...item, y: 275 / height }))], width, height);
assert.equal(twoLines.length, 2, '跨行文字应分成两处圈选');

const separateColumns = mergeSelectionRects([...chineseLine, glyph(420, 240)], width, height);
assert.equal(separateColumns.length, 2, '同一行相隔很远的区块不能连成一个圈');

const duplicateFragments = mergeSelectionRects([chineseLine[0], chineseLine[0], chineseLine[1]], width, height);
assert.equal(duplicateFragments.length, 1, '重叠的旧选区片段应合并');

const shortCorrection = calloutSize('改', 'correct', width, height);
const longerCorrection = calloutSize('改正内容', 'correct', width, height);
assert.ok(shortCorrection.width * width <= 28, '单字改正圈应贴合文字');
assert.ok(longerCorrection.width > shortCorrection.width, '改正圈应随文字增长');
assert.deepEqual(calloutSize('改', 'insert', width, height), shortCorrection, '增补圈与改正圈应使用相同尺寸');
assert.ok(calloutSize('请核对', 'comment', width, height).width < .1, '短批注应是紧凑无框文字');
assert.ok(calloutSize('请核对后修改', 'comment', width, height).width > calloutSize('请核对', 'comment', width, height).width, '批注应随文字增长');
assert.ok(calloutSize('请核对', 'comment', width, height, 18).width > calloutSize('请核对', 'comment', width, height, 10.5).width, '字号变化应改变页内文字尺寸');

const metrics = pageTextMetrics([glyph(50, 240), glyph(62, 240), glyph(50, 275), glyph(62, 275)]);
assert.ok(Math.abs(metrics.typicalHeight * height - 18) < .01, '应解析文字层字高');
assert.ok(Math.abs(metrics.linePitch * height - 35) < .01, '应解析文字层行距');

const anchor = glyph(50, 240, 35);
const frame = defaultSourceFrame(anchor, width, height);
assert.ok((frame.width - anchor.width) * width <= 2.1, '原文方框的水平留白应不超过约 1px');
assert.ok((frame.height - anchor.height) * height <= 2.1, '原文方框的垂直留白应不超过约 1px');
const tail = deletionTailSegments(frame, width, height);
assert.ok(tail.length >= 3, '删除尾巴应由连续曲线构成');
assert.ok(tail[0].start.x >= frame.x + frame.width, '尾巴应从文字框右边起笔');
assert.ok(tail[0].start.y < frame.y + frame.height / 2, '尾巴起点应在框的上半部');
assert.ok(tail.every((part) => [part.control1, part.control2, part.end].every((point) => point.y < anchor.y + anchor.height / 2)), '删除尾巴不能向下穿过文字');
assert.ok(tail[tail.length - 1].end.y < tail[0].start.y, '删除尾巴应总体向上');
const leftTarget = { x: frame.x - .08, y: frame.y + frame.height / 2 };
const leftTail = deletionTailSegments(frame, width, height, leftTarget);
assert.ok(leftTail[0].start.x <= frame.x, '拖动尾巴到左侧时起笔应转到框的左边');
assert.ok(leftTail.at(-1).end.x < frame.x, '拖动后的尾巴应指向框外左侧');
assert.ok(Math.abs(leftTail.at(-1).end.x - leftTarget.x) < .001, '尾巴末端应跟随拖动位置');
const closeTail = deletionTailSegments(frame, width, height, { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
assert.ok(closeTail.at(-1).end.x > frame.x + frame.width, '即使手柄拖进框内，尾巴也应留在框外');

const below = insertionFork(anchor, width, height, { x: .3, y: .5, width: .08, height: .04 });
const above = insertionFork(anchor, width, height, { x: .3, y: .1, width: .08, height: .04 });
assert.ok(below.tip.x < anchor.x + anchor.width && below.tip.x > anchor.x + anchor.width * .8, '增补竖线应穿过选中文字末尾');
assert.equal(below.tip.x, below.base.x, '增补主干应是竖线');
assert.ok(below.tip.y >= anchor.y && below.base.y <= anchor.y + anchor.height, '增补竖线应限制在字高以内');
assert.ok((below.base.y - below.tip.y) * height <= anchor.height * height, '增补竖线不能超过字高');
assert.ok((below.rightWing.x - below.leftWing.x) * width < anchor.height * height * .6, '增补分叉应保持短小');
assert.ok(below.leftWing.y < below.tip.y && below.rightWing.y < below.tip.y, '文字圈在下时分叉应向上');
assert.ok(above.leftWing.y > above.tip.y && above.rightWing.y > above.tip.y, '文字圈在上时分叉应向下');
const tallSelection = { x: .2, y: .2, width: .04, height: 30 / height };
const glyphFork = insertionFork(tallSelection, width, height, { x: .3, y: .1, width: .08, height: .04 }, 38 / height, 'after', 14 / height);
const legacyFork = insertionFork(tallSelection, width, height, { x: .3, y: .1, width: .08, height: .04 }, 38 / height);
assert.ok((glyphFork.rightWing.y - glyphFork.base.y) * height <= 14, '有字号时增补分叉连同竖干应接近实际字高');
assert.ok((legacyFork.rightWing.y - legacyFork.base.y) * height <= 21, '旧标注的高选区也不能画出过长分叉');
const selectionLines = [anchor, { ...anchor, x: anchor.x + .12, y: anchor.y + .05 }];
const beforeAnchor = insertionAnchor(selectionLines, 'before');
const afterAnchor = insertionAnchor(selectionLines, 'after');
assert.equal(beforeAnchor, selectionLines[0], '文字前增补应锚定跨行选区的首段');
assert.equal(afterAnchor, selectionLines[1], '文字后增补应锚定跨行选区的末段');
const beforeFork = insertionFork(beforeAnchor, width, height, undefined, undefined, 'before');
const afterFork = insertionFork(afterAnchor, width, height, undefined, undefined, 'after');
assert.ok(beforeFork.tip.x < beforeAnchor.x + beforeAnchor.width * .2, '文字前增补应靠近首字左边缘');
assert.ok(afterFork.tip.x > afterAnchor.x + afterAnchor.width * .8, '文字后增补应靠近末字右边缘');
const beforeLeader = leaderEndpoints({ type: 'insert', rects: selectionLines, insertionSide: 'before' }, { x: .05, y: .05, width: .08, height: .04 }, width, height);
assert.equal(beforeLeader.x1, beforeFork.base.x, '页内引线应从文字前分叉起笔');
const legacyLeader = leaderEndpoints({ type: 'insert', rects: selectionLines }, { x: .05, y: .05, width: .08, height: .04 }, width, height);
assert.equal(legacyLeader.x1, afterFork.base.x, '旧工程增补应继续显示在文字后');

const mark = { type: 'correct', rects: [anchor], outlines: [{ x: .3, y: .3, width: .08, height: .03 }] };
assert.deepEqual(sourceFrames(mark, width, height), mark.outlines, '手动调整的原文框应独立保存');
const leader = leaderEndpoints(mark, { x: .55, y: .3, width: .08, height: .04 }, width, height);
assert.ok(leader.x1 > .3, '引线应跟随移动后的原文圈');

const callout = { x: .42, y: .15, width: .16, height: .05 };
const sourceRect = { x: .45, y: .28, width: .045, height: .025 };
const calloutEllipse = (point) => ((point.x - callout.x - callout.width / 2) / (callout.width / 2)) ** 2 +
  ((point.y - callout.y - callout.height / 2) / (callout.height / 2)) ** 2;
for (const type of ['correct', 'insert']) {
  const joined = leaderEndpoints({ type, rects: [sourceRect] }, callout, width, height);
  assert.ok(calloutEllipse({ x: joined.x1, y: joined.y1 }) > 1, `${type} 引线应从文字圈外接向批注圈`);
  const endpoint = calloutEllipse({ x: joined.x2, y: joined.y2 });
  assert.ok(endpoint < 1 && endpoint > .4, `${type} 引线应穿过批注椭圆边线并略伸入圈内`);
  assert.ok(joined.x2 < callout.x + callout.width / 2, `${type} 斜向连接应落在椭圆靠近原文的一侧`);
}
const verticalBox = { x: .3, y: .08, width: .12, height: .04 };
const verticalSource = { x: .335, y: .18, width: .04, height: .02 };
const verticalLeader = leaderEndpoints({ type: 'insert', rects: [verticalSource], insertionSide: 'before' }, verticalBox, width, height);
assert.ok(Math.abs(verticalLeader.x1 - verticalLeader.x2) < .0001, '竖直增补引线应保持原有直线方向');
const verticalOffset = (verticalLeader.x2 - verticalBox.x - verticalBox.width / 2) / (verticalBox.width / 2);
const verticalOvalBottom = verticalBox.y + verticalBox.height / 2 + verticalBox.height / 2 * Math.sqrt(1 - verticalOffset ** 2);
assert.ok(verticalLeader.y2 < verticalOvalBottom && (verticalOvalBottom - verticalLeader.y2) * height <= 2.1, '竖直引线应穿过椭圆边线并在圈内短距离收笔');

const joinStrokes = positionMarkStrokes({ type: 'join', rects: [glyph(60, 200, 95), glyph(50, 230, 115)] }, width, height);
assert.equal(joinStrokes.length, 2, '接排应在相邻两行各绘制一段连接符');
assert.ok(joinStrokes[0][0].start.y > 200 / height, '接排第一段在第一行文字下方');
assert.ok(joinStrokes[1][0].start.y < 230 / height, '接排第二段在第二行文字上方');
assert.equal(positionMarkStrokes({ type: 'join', rects: [anchor] }, width, height).length, 0, '单行不可误绘接排');
const paragraphStrokes = positionMarkStrokes({ type: 'newParagraph', rects: [glyph(160, 300, 85)] }, width, height);
assert.equal(paragraphStrokes.length, 4, '另起段应包含向右开口括弧、左向箭头及竖线');
const caretX = 245 / width;
assert.ok(paragraphStrokes[0][0].end.x >= caretX, '括弧拐点应位于选中文字末尾光标处');
assert.ok(paragraphStrokes[0][0].start.x > paragraphStrokes[0][0].end.x, '括弧上端应向右展开');
assert.ok(paragraphStrokes[0][1].end.x > paragraphStrokes[0][0].end.x, '括弧下端也应向右展开');
assert.equal(paragraphStrokes[1][0].start.x, paragraphStrokes[0][0].end.x, '引线应与括弧拐点无缝连接');
assert.ok(paragraphStrokes[1][1].end.x < paragraphStrokes[1][1].start.x, '横线应指向左边');
assert.equal(paragraphStrokes[1][1].end.x, paragraphStrokes[3][0].start.x, '左向箭头应指向短竖线');
assert.equal(paragraphStrokes[3][0].start.x, paragraphStrokes[3][0].end.x, '末端应为竖直短线');
const narrowParagraph = positionMarkStrokes({ type: 'newParagraph', rects: [glyph(160, 300, 20)] }, width, height);
assert.ok(paragraphStrokes[0][0].end.x > narrowParagraph[0][0].end.x, '括弧锚点应跟随选区末尾移动');
const wrappedParagraph = positionMarkStrokes({ type: 'newParagraph', rects: [glyph(160, 300, 85), glyph(50, 335, 60)] }, width, height);
assert.equal(wrappedParagraph.length, 4, '跨行选择只在最后一行的末尾画一个符号');
assert.ok(wrappedParagraph[0][0].end.y > paragraphStrokes[0][0].end.y, '跨行选区的括弧应跟随最后一行');
const movedParagraph = positionMarkStrokes({ type: 'newParagraph', rects: [glyph(160, 300, 85)], positionOffset: { x: .04, y: .03 } }, width, height);
for (let stroke = 0; stroke < paragraphStrokes.length; stroke += 1) {
  for (let segment = 0; segment < paragraphStrokes[stroke].length; segment += 1) {
    assert.ok(Math.abs(movedParagraph[stroke][segment].start.x - paragraphStrokes[stroke][segment].start.x - .04) < 1e-9, '拖动应平移整个符号');
    assert.ok(Math.abs(movedParagraph[stroke][segment].start.y - paragraphStrokes[stroke][segment].start.y - .03) < 1e-9, '拖动应保留符号内部形状');
  }
}

console.log('几何检查通过：精准方框、删除尾巴、增补锚点、接排、另起段及引线。');
