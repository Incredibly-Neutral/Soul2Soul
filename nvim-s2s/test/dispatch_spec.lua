-- ============================================================================
-- :S2S dispatcher spec — routing and argv, with spawn stubbed out.
--
-- No binary is started: `s2s.spawn.run` is replaced with a capture function, so
-- these assertions are about what the plugin *would* execute.
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

local ok_spawn, spawn = pcall(require, 's2s.spawn')
if not ok_spawn or type(spawn) ~= 'table' then
  print('SKIP dispatch_spec: s2s.spawn missing')
  return suite
end

-- Capture instead of spawn.
local captured = nil
local real_run = spawn.run
spawn.run = function(spec, _)
  captured = spec
end

local ok_mod, s2s = pcall(require, 's2s')
if not ok_mod or type(s2s.dispatch) ~= 'function' then
  spawn.run = real_run
  print('SKIP dispatch_spec: s2s.dispatch missing')
  return suite
end

s2s.setup({ bin = 's2s', notify = false, confirm_save = false, abbrev = false })

-- A real file on disk so ensure_saved/stat behave normally.
local TEST_DIR = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2):match('^(.*)[/\\]') or '.', ':p')
local NOTE = TEST_DIR .. 'tmp-dispatch-note.md'
local fd = io.open(NOTE, 'w')
fd:write('---\nslug: dispatch\n---\nbody\n')
fd:close()
vim.cmd('edit ' .. NOTE)

local state = require('s2s.state')

local function dispatch(args)
  captured = nil
  -- The stubbed spawn never calls back, so clear the busy flag by hand.
  state.set_busy(vim.api.nvim_get_current_buf(), false)
  s2s.dispatch(args)
  state.set_busy(vim.api.nvim_get_current_buf(), false)
  return captured
end

-- ---------------------------------------------------------------------------
-- action resolution
-- ---------------------------------------------------------------------------

eq(s2s.resolve_action('upload'), 'upload', 'resolve: long form')
eq(s2s.resolve_action('up'), 'upload', 'resolve: alias')
eq(s2s.resolve_action('prop'), 'propose', 'resolve: unique prefix')
eq(s2s.resolve_action('cfg'), 'config', 'resolve: alias')
eq(s2s.resolve_action('p'), nil, 'resolve: ambiguous prefix rejected')
eq(s2s.resolve_action('nope'), nil, 'resolve: unknown rejected')
eq(s2s.resolve_action(nil), nil, 'resolve: nil input')

-- ---------------------------------------------------------------------------
-- routing + argv
-- ---------------------------------------------------------------------------

local spec = dispatch({ 'upload' })
ok(spec ~= nil, 'upload: spawns')
eq(spec and spec.group, 'author', 'upload: group')
eq(spec and spec.action, 'upload', 'upload: action')
eq(spec and spec.note, NOTE, 'upload: absolute note path')
eq(spec and spec.args and #spec.args, 0, 'upload: no extra args')

spec = dispatch({ 'up', '--publication', 'polyphony.eth' })
eq(spec and spec.action, 'upload', 'alias: upload')
eq(spec and spec.args and spec.args[1], '--publication', 'args: flag forwarded')
eq(spec and spec.args and spec.args[2], 'polyphony.eth', 'args: value forwarded')

spec = dispatch({ 'config', 'get', 'pinataGateway' })
eq(spec and spec.group, 'config', 'config: group')
eq(spec and spec.action, 'get', 'config: subcommand')
eq(spec and spec.args and spec.args[1], 'pinataGateway', 'config: key forwarded')

spec = dispatch({ 'new', 'mypub', '--repo', 'me/repo' })
eq(spec and spec.group, 'publication', 'new: group')
eq(spec and spec.action, 'new', 'new: action is always new')
eq(spec and spec.args and spec.args[1], 'mypub', 'new: name forwarded')
eq(spec and spec.args and spec.args[3], 'me/repo', 'new: repo forwarded')

-- ---------------------------------------------------------------------------
-- no spawn for the read-only actions
-- ---------------------------------------------------------------------------

captured = nil
local notified = {}
local real_notify = vim.notify
vim.notify = function(msg)
  notified[#notified + 1] = tostring(msg)
end
s2s.dispatch({ 'help' })
s2s.dispatch({ 'bogus' })
vim.notify = real_notify
eq(captured, nil, 'help/unknown: nothing spawned')
ok(#notified >= 1, 'unknown action notifies')

-- ---------------------------------------------------------------------------
-- cleanup
-- ---------------------------------------------------------------------------

spawn.run = real_run
os.remove(NOTE)
vim.cmd('silent! enew!')

return suite
