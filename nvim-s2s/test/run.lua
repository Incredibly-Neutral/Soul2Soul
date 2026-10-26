-- ============================================================================
-- nvim-s2s test entry point.
--
--   cd nvim-s2s && nvim --headless -l test/run.lua
--
-- Runs the pure formatter spec, then the spawn integration spec if s2s.spawn
-- exists (it is written in parallel; absence is a SKIP, not a failure).
-- Prints "ok <n> assertions, <k> failures" and exits non-zero on failure.
-- ============================================================================

local THIS = debug.getinfo(1, 'S').source:sub(2)
local TEST_DIR = THIS:match('^(.*)[/\\][^/\\]+$') or '.'
local ROOT = TEST_DIR:match('^(.*)[/\\][^/\\]+$') or '.'

-- Make `require('s2s.*')` work without a runtimepath/plugin manager.
package.path = table.concat({
  ROOT .. '/lua/?.lua',
  ROOT .. '/lua/?/init.lua',
  package.path,
}, ';')

local function run_spec(label, loader)
  local ok, result = pcall(loader)
  if not ok then
    print(string.format('FAIL %s: %s', label, tostring(result)))
    return { assertions = 0, failures = 1, messages = {} }
  end
  return result or { assertions = 0, failures = 0, messages = {} }
end

local total = { assertions = 0, failures = 0, messages = {} }

local function merge(suite, label)
  total.assertions = total.assertions + (suite.assertions or 0)
  total.failures = total.failures + (suite.failures or 0)
  for _, msg in ipairs(suite.messages or {}) do
    total.messages[#total.messages + 1] = label .. ': ' .. msg
  end
end

merge(run_spec('format_spec', function()
  return dofile(TEST_DIR .. '/format_spec.lua')
end), 'format_spec')

local has_spawn = pcall(require, 's2s.spawn')
if has_spawn then
  merge(run_spec('spawn_e2e', function()
    return dofile(TEST_DIR .. '/spawn_e2e.lua')
  end), 'spawn_e2e')
else
  print('SKIP spawn_e2e')
end

for _, msg in ipairs(total.messages) do
  print('not ok: ' .. msg)
end

print(string.format('ok %d assertions, %d failures', total.assertions, total.failures))

if total.failures > 0 then
  vim.cmd('cq')
end
