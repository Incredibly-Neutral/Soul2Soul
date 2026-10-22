-- ============================================================================
-- s2s.format spec — plain-Lua assert harness (no busted, no plenary).
--
--   nvim --headless -l test/run.lua
--
-- Returns { assertions, failures, messages } so run.lua can aggregate.
-- ============================================================================

local format = require('s2s.format')

local THIS = debug.getinfo(1, 'S').source:sub(2)
local TEST_DIR = THIS:match('^(.*)[/\\][^/\\]+$') or '.'

local suite = { assertions = 0, failures = 0, messages = {} }

local function show(v)
  if type(v) ~= 'table' then
    return string.format('%q', tostring(v))
  end
  local parts = {}
  for i, item in ipairs(v) do
    parts[i] = show(item)
  end
  return '{' .. table.concat(parts, ', ') .. '}'
end

local function deep_eq(a, b)
  if type(a) ~= type(b) then
    return false
  end
  if type(a) ~= 'table' then
    return a == b
  end
  for k, v in pairs(a) do
    if not deep_eq(v, b[k]) then
      return false
    end
  end
  for k in pairs(b) do
    if a[k] == nil then
      return false
    end
  end
  return true
end

local function eq(actual, expected, label)
  suite.assertions = suite.assertions + 1
  if not deep_eq(actual, expected) then
    suite.failures = suite.failures + 1
    suite.messages[#suite.messages + 1] =
      string.format('%s: expected %s, got %s', label, show(expected), show(actual))
  end
end

local function ok(cond, label)
  eq(not not cond, true, label)
end

local function contains(haystack, needle, label)
  suite.assertions = suite.assertions + 1
  if type(haystack) ~= 'string' or not haystack:find(needle, 1, true) then
    suite.failures = suite.failures + 1
    suite.messages[#suite.messages + 1] =
      string.format('%s: %s does not contain %s', label, show(haystack), show(needle))
  end
end

-- Find the rendered line for a key ("key : value", padded key).
local function line_for(lines, key)
  for _, line in ipairs(lines) do
    local k, v = line:match('^(%S+) +: (.*)$')
    if k == key then
      return v, line
    end
  end
  return nil
end

local function has_key(lines, key)
  return line_for(lines, key) ~= nil
end

local function fixture(name)
  local path = TEST_DIR .. '/fixtures/' .. name .. '.json'
  local fd = assert(io.open(path, 'r'), 'missing fixture: ' .. path)
  local body = fd:read('*a')
  fd:close()
  return vim.json.decode(body)
end

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

local upload = fixture('upload')
local propose = fixture('propose')
local preview = fixture('preview')
local publish = fixture('publish')
local revoke = fixture('revoke')
local new_pub = fixture('publication-new')
local failure = fixture('failure')
local future = fixture('open-shape')

-- ---------------------------------------------------------------------------
-- lines(): the six shapes
-- ---------------------------------------------------------------------------

local ul = format.lines(upload)
eq(line_for(ul, 'note'), '/home/joera/notes/hello-s2s.md', 'upload lines: note whole path')
eq(line_for(ul, 'kuboCid'), upload.kuboCid, 'upload lines: kuboCid whole (no truncation)')
eq(line_for(ul, 'frontmatterWritten'), 'yes', 'upload lines: boolean renders as yes')
ok(not has_key(ul, 'txHash'), 'upload lines: no txHash line')
ok(ul[1]:find('^note') ~= nil, 'upload lines: known order starts at note')

eq(line_for(format.lines(propose), 'txHash'), propose.txHash, 'propose lines: txHash')
ok(not has_key(format.lines(propose), 'frontmatterWritten'), 'propose lines: no frontmatterWritten')

local pl = format.lines(preview)
eq(line_for(pl, 'render.previewUrl'), preview.render.previewUrl, 'preview lines: previewUrl')
ok(not has_key(pl, 'render.prodUrl'), 'preview lines: no prodUrl synthesized')
eq(line_for(pl, 'render.path'), preview.render.path, 'preview lines: render path')

local pub = format.lines(publish)
eq(line_for(pub, 'render.prodUrl'), publish.render.prodUrl, 'publish lines: prodUrl')
eq(line_for(pub, 'render.previewUrl'), publish.render.previewUrl, 'publish lines: previewUrl')
eq(line_for(pub, 'txHash'), publish.txHash, 'publish lines: txHash')

local rv = format.lines(revoke)
eq(line_for(rv, 'txHash'), revoke.txHash, 'revoke lines: txHash')
ok(not has_key(rv, 'kuboCid'), 'revoke lines: no kuboCid (not in revoke shape)')

local nl = format.lines(new_pub)
eq(line_for(nl, 'name'), new_pub.name, 'new lines: name')
eq(line_for(nl, 'owners'), new_pub.owners[1], 'new lines: owners joined')
eq(line_for(nl, 'authors'), table.concat(new_pub.authors, ', '), 'new lines: authors joined')
ok(not has_key(nl, 'configCid'), 'new lines: JSON null configCid skipped (no nil text)')
eq(line_for(nl, 'feed'), new_pub.feed, 'new lines: feed')

-- Column alignment: every rendered line puts " : " at the same column.
local function aligned(lines, label)
  local col
  for _, line in ipairs(lines) do
    local pos = line:find(' : ', 1, true)
    if not pos then
      suite.assertions = suite.assertions + 1
      suite.failures = suite.failures + 1
      suite.messages[#suite.messages + 1] = label .. ': not "key : value": ' .. show(line)
      return
    end
    col = col or pos
    if pos ~= col then
      suite.assertions = suite.assertions + 1
      suite.failures = suite.failures + 1
      suite.messages[#suite.messages + 1] = label .. ': keys not column-aligned'
      return
    end
  end
  ok(true, label .. ': keys column-aligned')
end

aligned(ul, 'upload lines')
aligned(nl, 'new lines')

-- ---------------------------------------------------------------------------
-- summary(): one line, basename, the identifying field
-- ---------------------------------------------------------------------------

eq(
  format.summary(upload),
  'uploaded hello-s2s.md · ' .. upload.kuboCid,
  'summary: upload → verb + basename + CID'
)
eq(
  format.summary(propose),
  'proposed hello-s2s.md · tx ' .. propose.txHash,
  'summary: propose → txHash'
)
ok(format.summary(publish):find('published hello-s2s.md', 1, true) == 1, 'summary: publish verb')
contains(format.summary(publish), publish.txHash, 'summary: publish identifies by txHash')
ok(
  format.summary(publish):find(publish.kuboCid, 1, true) == nil,
  'summary: publish does not dump the CID'
)
eq(format.summary(preview), 'previewed hello-s2s.md · ' .. preview.kuboCid, 'summary: preview')
eq(format.summary(revoke), 'revoked hello-s2s.md · tx ' .. revoke.txHash, 'summary: revoke')
eq(
  format.summary(new_pub),
  'created ' .. new_pub.name .. ' · ' .. new_pub.safeAddress,
  'summary: publication new → name'
)
ok(format.summary(upload):find('hello-s2s.md', 1, true) ~= nil, 'summary: basename present')
ok(format.summary(upload):find('/home/joera', 1, true) == nil, 'summary: full path not leaked')
ok(format.summary(upload):find('\n', 1, true) == nil, 'summary: single line')
eq(format.summary(future), 'uploaded hello world.md · ' .. future.kuboCid, 'summary: path basename')
eq(format.summary(failure), nil, 'summary: nil for the failure envelope')

-- ---------------------------------------------------------------------------
-- Failure envelope
-- ---------------------------------------------------------------------------

eq(format.error_message(failure), failure.error, 'error_message: envelope error verbatim')
eq(format.is_failure(failure, 1), true, 'is_failure: envelope + exit 1')
eq(format.is_failure(failure, 0), true, 'is_failure: ok == false alone')
eq(format.lines(failure), { 'error : ' .. failure.error }, 'lines: failure is one error line')
eq(format.summary(failure), nil, 'summary: failure has no summary line')

-- ---------------------------------------------------------------------------
-- Total functions: {}, nil, garbage
-- ---------------------------------------------------------------------------

eq(format.lines({}), {}, 'lines: {} → {}')
eq(format.extras({}), {}, 'extras: {} → {}')
eq(format.report({}), {}, 'report: {} → {}')
eq(format.summary({}), nil, 'summary: {} → nil')
eq(format.open_target({}), {}, 'open_target: {} → {}')
eq(format.lines(nil), {}, 'lines: nil → {}')
eq(format.extras(nil), {}, 'extras: nil → {}')
eq(format.report(nil), {}, 'report: nil → {}')
eq(format.summary(nil), nil, 'summary: nil → nil')
eq(format.open_target(nil), {}, 'open_target: nil → {}')
eq(
  format.error_message(nil),
  's2s failed (no error message returned)',
  'error_message: nil fallback'
)
ok(type(format.lines(42)) == 'table', 'lines: number input stays total')
ok(format.summary('garbage') == nil, 'summary: string input → nil')
eq(format.extras(true), {}, 'extras: boolean input → {}')
eq(format.report(42), {}, 'report: garbage → {}')

-- ---------------------------------------------------------------------------
-- Open-shape rule
-- ---------------------------------------------------------------------------

local extras = format.extras(future)
eq(#extras, 4, 'extras: only unknown top-level scalars survive')
eq(extras[1]:match('^(%S+)'), 'authorContract', 'extras: sorted, first = authorContract')
eq(extras[2]:match('^(%S+)'), 'authorGenesis', 'extras: sorted, second = authorGenesis')
eq(line_for(extras, 'pinned'), 'yes', 'extras: boolean scalar rendered')
eq(line_for(extras, 'revision'), '3', 'extras: number scalar rendered')
ok(not has_key(format.lines(future), 'authorContract'), 'extras: not in known lines')
ok(not has_key(extras, 'author'), 'extras: unknown nested object ("author") dropped')
ok(not has_key(extras, 'deals'), 'extras: unknown nested array dropped')
ok(
  not table.concat(extras, '\n'):find('table:', 1, true),
  'extras: never renders a table as text'
)
aligned(extras, 'extras')

local report = format.report(future)
eq(report[1], format.summary(future), 'report: summary first')
eq(line_for(report, 'revision'), '3', 'report: extras last')
ok(#report > #format.lines(future) + #extras, 'report: includes everything')

-- ---------------------------------------------------------------------------
-- open_target()
-- ---------------------------------------------------------------------------

eq(format.open_target(publish).url, publish.render.prodUrl, 'open_target: publish → prodUrl')
eq(format.open_target(publish).path, publish.render.path, 'open_target: path')
eq(format.open_target(preview).url, preview.render.previewUrl, 'open_target: preview → previewUrl')
eq(format.open_target(upload), {}, 'open_target: upload has nothing to open')
ok(format.open_target(publish).url ~= nil, 'open_target: returned url exists')

-- ---------------------------------------------------------------------------
-- exit_kind()
-- ---------------------------------------------------------------------------

eq(format.exit_kind(0), 'ok', 'exit_kind: 0')
eq(format.exit_kind(1), 'error', 'exit_kind: 1')
eq(format.exit_kind(2), 'usage', 'exit_kind: 2')
eq(format.exit_kind(3), 'crash', 'exit_kind: 3')
eq(format.exit_kind(nil), 'crash', 'exit_kind: nil')
eq(format.exit_kind('nope'), 'crash', 'exit_kind: non-number')

return suite
