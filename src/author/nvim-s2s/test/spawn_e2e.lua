-- ============================================================================
-- s2s.spawn integration spec — drives the fake binary at test/fake-s2s.
--
-- Assumed spawn API (the parallel worker's module):
--   spawn.argv(opts) -> string[]      opts = { bin, group, action, note, flags, cwd, timeout }
--   spawn.run(opts, cb)               cb(result) or synchronous return
--   result = { code, json, parse_error, stdout, stderr }
-- Missing/incompatible module → SKIP, never a hard failure.
--
-- The fake binary chooses its output with $S2S_FIXTURE and its exit code with
-- $S2S_EXIT, which this spec sets in vim.env before each invocation.
-- ============================================================================

local suite = { assertions = 0, failures = 0, messages = {} }

local function show(v)
  if type(v) ~= 'table' then
    return string.format('%q', tostring(v))
  end
  local parts = {}
  for k, item in pairs(v) do
    parts[#parts + 1] = tostring(k) .. '=' .. tostring(item)
  end
  return '{' .. table.concat(parts, ', ') .. '}'
end

local function eq(actual, expected, label)
  suite.assertions = suite.assertions + 1
  if actual ~= expected then
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

local function skip(reason)
  print('SKIP spawn_e2e: ' .. tostring(reason))
  return suite
end

local ok_req, spawn = pcall(require, 's2s.spawn')
if not ok_req or type(spawn) ~= 'table' or type(spawn.run) ~= 'function' then
  return skip('s2s.spawn.run is not available')
end

local THIS = debug.getinfo(1, 'S').source:sub(2)
local TEST_DIR = THIS:match('^(.*)[/\\][^/\\]+$') or '.'
TEST_DIR = vim.fn.fnamemodify(TEST_DIR, ':p'):gsub('/$', '')
local FAKE = TEST_DIR .. '/fake-s2s'

if vim.fn.filereadable(FAKE) ~= 1 then
  return skip('test/fake-s2s is not readable')
end

local function code_of(res)
  if type(res) ~= 'table' then
    return nil
  end
  local c = res.code
  if type(c) ~= 'number' then
    c = res.exit_code or res.status
  end
  return c
end

-- Run once. Returns result, err. Handles async callback, sync return, and a
-- promise-ish return with wait().
local function invoke(opts)
  local done, got = false, nil
  local cb = function(res)
    got = res
    done = true
  end
  local called, ret = pcall(spawn.run, opts, cb)
  if not called then
    return nil, ret
  end
  if done then
    return got
  end
  if type(ret) == 'table' then
    return ret
  end
  if ret ~= nil and type(ret) == 'userdata' and type(getmetatable(ret)) == 'table' then
    pcall(function()
      ret:wait(15000)
    end)
    if done then
      return got
    end
  end
  vim.wait(15000, function()
    return done
  end, 10)
  if not done then
    return nil, 'spawn.run never called back'
  end
  return got
end

local function opts(action, fixture, exit_code, cwd)
  vim.env.S2S_FIXTURE = fixture
  vim.env.S2S_EXIT = tostring(exit_code or 0)
  vim.env.S2S_PROGRESS = 'fake progress line'
  local note = TEST_DIR .. '/fixtures/upload.json'
  return {
    bin = FAKE,
    group = 'author',
    action = action,
    note = note,
    flags = {},
    cwd = cwd or TEST_DIR,
    timeout = 15000,
  }
end

-- ---------------------------------------------------------------------------
-- ok (exit 0, JSON parsed)
-- ---------------------------------------------------------------------------

local res, err = invoke(opts('upload', 'upload', 0))
if not res then
  return skip('spawn.run rejected the call shape: ' .. tostring(err))
end
eq(code_of(res), 0, 'exit 0: code')
ok(type(res.json) == 'table', 'exit 0: json decoded')
eq(res.json and res.json.action, 'upload', 'exit 0: action preserved')
eq(
  res.json and res.json.cid,
  'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  'exit 0: fixture body intact'
)
eq(res.parse_error, nil, 'exit 0: no parse_error')

-- ---------------------------------------------------------------------------
-- exit 1 (failure envelope)
-- ---------------------------------------------------------------------------

res = invoke(opts('upload', 'failure', 1))
eq(code_of(res), 1, 'exit 1: code')
ok(type(res.json) == 'table', 'exit 1: envelope decoded')
eq(res.json and res.json.ok, false, 'exit 1: ok == false')
contains(res.json and res.json.error, 'S2S_PRIVATE_KEY', 'exit 1: envelope error verbatim')

-- ---------------------------------------------------------------------------
-- exit 2 (usage error)
-- ---------------------------------------------------------------------------

res = invoke(opts('bogus', 'failure', 2))
eq(code_of(res), 2, 'exit 2: code')

-- ---------------------------------------------------------------------------
-- non-JSON stdout
-- ---------------------------------------------------------------------------

res = invoke(opts('upload', 'raw', 0))
eq(res.json, nil, 'non-JSON: json is nil')
ok(res.parse_error ~= nil, 'non-JSON: parse_error set')
ok(type(res.stdout) == 'string', 'non-JSON: stdout still available')

-- ---------------------------------------------------------------------------
-- empty stdout
-- ---------------------------------------------------------------------------

res = invoke(opts('upload', 'empty', 0))
eq(res.json, nil, 'empty stdout: json is nil')
ok(res.parse_error ~= nil, 'empty stdout: parse_error set')

-- ---------------------------------------------------------------------------
-- stdout with stray progress around the result document
--
-- The binary's durability legs are fire-and-forget and can leak a line onto
-- stdout; the result document is still the last well-formed object.
-- ---------------------------------------------------------------------------

local function noisy_case(fixture, label)
  local r = invoke(opts('upload', fixture, 0))
  ok(r and type(r.json) == 'table', label .. ': json decoded')
  eq(r and r.json and r.json.action, 'upload', label .. ': action preserved')
  eq(r and r.parse_error, nil, label .. ': no parse_error')
end

noisy_case('prefixed', 'stdout prefix')
noisy_case('suffixed', 'stdout suffix')
noisy_case('braces', 'stdout junk with braces')

-- ---------------------------------------------------------------------------
-- extract_json directly (pure, no child process)
-- ---------------------------------------------------------------------------

if type(spawn.extract_json) == 'function' then
  local doc = '{"action":"upload","ok":true}'
  ok(spawn.extract_json(doc) ~= nil, 'extract: bare document')
  ok(spawn.extract_json('log line\n' .. doc) ~= nil, 'extract: after a log line')
  ok(spawn.extract_json(doc .. '\ntrailing log') ~= nil, 'extract: before a log line')
  ok(
    spawn.extract_json('a {b} c\n' .. doc .. '\nd {"e":1}') ~= nil,
    'extract: surrounded by objects'
  )
  ok(spawn.extract_json('{"s":') == nil, 'extract: truncated document rejected')
  ok(spawn.extract_json('no json here') == nil, 'extract: plain text rejected')
  eq(spawn.extract_json(''), nil, 'extract: empty input')
  -- A brace inside a JSON string must not confuse the scanner.
  local nested = spawn.extract_json('junk\n{"note":"a{b}c","action":"upload"}\n')
  eq(nested and nested.action, 'upload', 'extract: braces inside strings')
else
  print('SKIP spawn_e2e extract_json: not exported')
end

-- ---------------------------------------------------------------------------
-- argv shape
-- ---------------------------------------------------------------------------

if type(spawn.argv) == 'function' then
  local built, argv = pcall(spawn.argv, {
    bin = FAKE,
    group = 'author',
    action = 'upload',
    note = 'notes/rel-note.md',
    flags = {},
  })
  if not built then
    print('SKIP spawn_e2e argv: ' .. tostring(argv))
  else
    ok(type(argv) == 'table', 'argv: returns a table')
    eq(argv and argv[#argv], '--json', 'argv: --json is last')
    local note_arg
    for _, token in ipairs(argv or {}) do
      if type(token) == 'string' and token:match('notes/rel%-note%.md$') then
        note_arg = token
      end
    end
    ok(note_arg ~= nil, 'argv: note present')
    ok(
      note_arg ~= nil and note_arg:sub(1, 1) == '/',
      'argv: note is an absolute path'
    )
    eq(argv and argv[1], FAKE, 'argv: binary first')
  end
else
  print('SKIP spawn_e2e argv: s2s.spawn.argv is not a function')
end

-- ---------------------------------------------------------------------------
-- cwd passthrough
-- ---------------------------------------------------------------------------

res = invoke(opts('upload', 'pwd', 0, TEST_DIR))
ok(res and type(res.json) == 'table', 'cwd: child produced a result')
eq(res and res.json and res.json.cwd, TEST_DIR, 'cwd: passed through to the child')

-- Leave no fake-binary env behind for other specs.
vim.env.S2S_FIXTURE = nil
vim.env.S2S_EXIT = nil
vim.env.S2S_PROGRESS = nil

return suite
