const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'phone.html'), 'utf8');

/** Walks the page's divs and returns the parent id of each div with an id. */
function divTree() {
  const stack = [];
  const parents = {};
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)div\b([^>]*)>/g)) {
    if (m[1]) { stack.pop(); continue; }
    const id = (m[2].match(/\bid="([^"]+)"/) || [])[1] || null;
    if (id) parents[id] = stack[stack.length - 1];
    stack.push(id);
  }
  return { parents, depth: stack.length };
}

test('every div in the softphone page is closed', () => {
  assert.equal(divTree().depth, 0);
});

test('Settings is not inside the phone view, which is hidden when Settings opens', () => {
  const { parents } = divTree();
  assert.ok('view-settings' in parents);
  assert.equal(parents['view-settings'], parents['view-phone']);
  assert.equal(parents['call-history'], parents['view-phone']);
});
