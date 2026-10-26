-- s2s/health.lua — :checkhealth s2s
--
-- Reports presence, never values: config keys come from the binary already
-- masked, and even those we only list by name.

local M = {}

local health = vim.health or require('vim.health')

local FLOOR = { major = 0, minor = 10, patch = 0 }

local function first_line(text)
  if type(text) ~= 'string' then
    return nil
  end
  for line in text:gmatch('[^\r\n]+') do
    if not line:match('^%s*$') then
      return line
    end
  end
  return nil
end

local function parse_semver(value)
  local major, minor, patch = tostring(value):match('^(%d+)%.(%d+)%.(%d+)')
  if not major then
    return nil
  end
  return { major = tonumber(major), minor = tonumber(minor), patch = tonumber(patch) }
end

local function below(a, b)
  if a.major ~= b.major then
    return a.major < b.major
  end
  if a.minor ~= b.minor then
    return a.minor < b.minor
  end
  return a.patch < b.patch
end

local function resolve_bin(bin)
  if type(bin) ~= 'string' or bin == '' then
    return nil
  end
  if bin:sub(1, 1) == '/' then
    return vim.fn.executable(bin) == 1 and bin or nil
  end
  local found = vim.fn.exepath(bin)
  if type(found) == 'string' and found ~= '' then
    return found
  end
  return nil
end

local function check_bin(bin)
  if not bin then
    local opts = require('s2s').get_opts()
    health.error(
      string.format('`%s` not found on PATH', tostring(opts.bin)),
      { 'Install the s2s CLI, or point the plugin at it:', '  require("s2s").setup({ bin = "/abs/path/to/s2s" })' }
    )
    return nil
  end
  health.ok('binary: ' .. bin)
  return bin
end

local function check_version(bin)
  local ok, obj = pcall(function()
    return vim.system({ bin, '--version' }, { text = true, timeout = 5000 }):wait(5000)
  end)
  if not ok or type(obj) ~= 'table' then
    health.warn('`s2s --version` could not be run')
    return
  end
  if obj.code ~= 0 then
    health.warn(string.format('`s2s --version` exited %d — %s', obj.code or -1, first_line(obj.stderr) or 'no stderr'))
    return
  end

  local decoded_ok, decoded = pcall(vim.json.decode, obj.stdout or '')
  local version = decoded_ok and type(decoded) == 'table' and decoded.version or nil
  local parsed = version and parse_semver(version) or nil
  if not parsed then
    health.warn(
      '`s2s --version` did not return a parseable JSON version',
      { 'got: ' .. tostring(first_line(obj.stdout) or '(empty)') }
    )
    return
  end

  if below(parsed, { major = 0, minor = 1, patch = 0 }) then
    health.warn(string.format('s2s %s is older than the supported 0.1.0', version))
  else
    health.ok(string.format('s2s %s', version))
  end
end

local function check_config(bin)
  local ok, obj = pcall(function()
    return vim.system({ bin, 'config', 'list', '--json' }, { text = true, timeout = 15000 }):wait(15000)
  end)
  if not ok or type(obj) ~= 'table' then
    health.warn('`s2s config list --json` could not be run')
    return
  end
  if obj.code ~= 0 then
    health.warn(
      string.format('`s2s config list --json` exited %d', obj.code or -1),
      {
        first_line(obj.stderr) or 'no stderr',
        '',
        'Configure the CLI with its own surface:',
        '  s2s config list',
        '  s2s config set <key> <value> [--local]',
        '  s2s config --help',
      }
    )
    return
  end

  local decoded_ok, decoded = pcall(vim.json.decode, obj.stdout or '')
  if not decoded_ok or type(decoded) ~= 'table' or type(decoded.config) ~= 'table' then
    health.warn(
      '`s2s config list --json` did not return the expected JSON',
      { 'Run `s2s config --help` for the binary\'s own guidance.' }
    )
    return
  end

  local names = {}
  for key in pairs(decoded.config) do
    names[#names + 1] = tostring(key)
  end
  table.sort(names)

  if #names == 0 then
    health.info('no config keys set (s2s config list is empty)')
  else
    health.ok(
      string.format('%d config key(s) present (names only, never values): %s', #names, table.concat(names, ', '))
    )
  end
end

local function check_nvim()
  local v = vim.version()
  local current = { major = v.major, minor = v.minor, patch = v.patch }
  local label = string.format('Neovim %d.%d.%d', v.major, v.minor, v.patch or 0)
  if below(current, FLOOR) then
    health.error(label .. ' is below the 0.10 floor (vim.system / vim.ui.open)')
  else
    health.ok(label .. ' (>= 0.10)')
  end
end

function M.check()
  health.start('s2s')
  check_nvim()

  local bin = resolve_bin(require('s2s').get_opts().bin)
  bin = check_bin(bin)
  if not bin then
    health.info('skipping `s2s --version` and `s2s config list` — no binary')
    return
  end

  check_version(bin)
  check_config(bin)
end

return M
