-- ============================================================================
-- s2s.state spec — last-result-per-buffer + busy flags, dropped on BufWipeout.
--
--   nvim --headless -l test/run.lua
--
-- Returns { assertions, failures, messages } so run.lua can aggregate.
-- ============================================================================

local state = require('s2s.state')

local suite = { assertions = 0, failures = 0, messages = {} }

local function eq(actual, expected, label)
  suite.assertions = suite.assertions + 1
  if actual ~= expected then
    suite.failures = suite.failures + 1
    suite.messages[#suite.messages + 1] =
      string.format('%s: expected %s, got %s', label, tostring(expected), tostring(actual))
  end
end

local function new_buf()
  local buf = vim.api.nvim_create_buf(true, false)
  vim.api.nvim_buf_set_name(buf, string.format('/tmp/s2s-state-%d.md', buf))
  return buf
end

local entry = { action = 'upload', result = { action = 'upload', cid = 'bafy1' }, code = 0, at = 1, ms = 5 }

-- empty by default
local a = new_buf()
eq(state.get(a), nil, 'get: empty for a fresh buffer')
eq(state.is_busy(a), false, 'busy: false for a fresh buffer')

-- set / get / per-buffer isolation
state.set(a, entry)
eq(state.get(a), entry, 'set/get: same entry back')
eq(state.get(a).result.cid, 'bafy1', 'set/get: result payload intact')

local b = new_buf()
eq(state.get(b), nil, 'set/get: results do not leak across buffers')

-- busy lifecycle
state.set_busy(a, true)
eq(state.is_busy(a), true, 'busy: set')
eq(state.is_busy(b), false, 'busy: only for its own buffer')
state.set_busy(a, false)
eq(state.is_busy(a), false, 'busy: cleared')

-- failed results are remembered too (so :S2sLast works after a red notify)
local failed = { action = 'upload', result = { ok = false, error = 'nope' }, code = 2, at = 2 }
state.set(a, failed)
eq(state.get(a).code, 2, 'set: failure entry kept')
eq(state.get(a).result.error, 'nope', 'set: failure envelope kept')

-- invalid buffers are never stored
state.set(0, entry)
eq(state.get(0), nil, 'set: buffer 0 ignored')
state.set_busy(0, true)
eq(state.is_busy(0), false, 'busy: buffer 0 ignored')

-- clear
state.clear(a)
eq(state.get(a), nil, 'clear: entry dropped')

-- BufWipeout drops the state
local c = new_buf()
state.set(c, entry)
state.set_busy(c, true)
vim.api.nvim_buf_delete(c, { force = true })
eq(state.get(c), nil, 'wipeout: last result dropped')
eq(state.is_busy(c), false, 'wipeout: busy flag dropped')

return suite
