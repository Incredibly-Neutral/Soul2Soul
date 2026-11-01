-- s2s/commands.lua — the only module that defines commands.
--
-- One interface: `:S2S <action> [args]` (and the `:s2s` abbreviation). The
-- camelCase commands from the first cut are kept as aliases so existing
-- <Plug> maps and muscle memory keep working.
--
-- Command bodies require `s2s` lazily: nothing spawns until a command runs.

local M = {}

local api = vim.api

local function s2s()
  return require('s2s')
end

--- Actions the dispatcher accepts. Order is the completion order.
M.actions = {
  'upload',
  'propose',
  'preview',
  'publish',
  'revoke',
  'new',
  'config',
  'last',
  'health',
  'help',
}

--- Subcommands of `:S2S config` (the binary's config group).
M.config_subs = { 'list', 'get', 'set', 'unset', 'path' }

--- Which binary group/action each dispatcher word maps to (for completions).
local ACTION_TARGET = {
  upload = { 'author', 'upload' },
  propose = { 'author', 'propose' },
  preview = { 'author', 'preview' },
  publish = { 'author', 'publish' },
  revoke = { 'author', 'revoke' },
  new = { 'publication', 'new' },
}

local SIMPLE = {
  { name = 'S2sUpload', fn = 'upload', desc = 'alias of :S2S upload' },
  { name = 'S2sPropose', fn = 'propose', desc = 'alias of :S2S propose' },
  { name = 'S2sPreview', fn = 'preview', desc = 'alias of :S2S preview' },
  { name = 'S2sPublish', fn = 'publish', desc = 'alias of :S2S publish' },
  { name = 'S2sRevoke', fn = 'revoke', desc = 'alias of :S2S revoke' },
  { name = 'S2sLast', fn = 'last', desc = 'alias of :S2S last' },
  { name = 'S2sHealth', fn = 'health', desc = 'alias of :S2S health' },
  { name = 'S2sHelp', fn = 'help', desc = 'alias of :S2S help' },
}

-- Flags are read from the binary's own --help output, once per session.
local flag_cache = {}

local function flags_for(group, action_key)
  local key = group .. ' ' .. action_key
  local cached = flag_cache[key]
  if cached then
    return cached
  end
  flag_cache[key] = {}
  local ok, obj = pcall(function()
    local opts = s2s().get_opts()
    local argv = { opts.bin, group, action_key, '--help', '--json' }
    return vim.system(argv, { text = true, timeout = 2000 }):wait(2000)
  end)
  if not ok or type(obj) ~= 'table' or obj.code ~= 0 then
    return {}
  end
  local flags = {}
  local seen = {}
  for flag in tostring(obj.stdout or ''):gmatch('%-%-[%w%-]+') do
    if not seen[flag] and flag ~= '--help' and flag ~= '--json' then
      seen[flag] = true
      flags[#flags + 1] = flag
    end
  end
  table.sort(flags)
  flag_cache[key] = flags
  return flags
end

local function matching(pool, lead)
  local out = {}
  for _, item in ipairs(pool) do
    if item:sub(1, #lead) == lead then
      out[#out + 1] = item
    end
  end
  return out
end

local function flag_completion(group, action_key, arglead)
  local out = {}
  for _, flag in ipairs(flags_for(group, action_key)) do
    if flag:sub(1, #arglead) == arglead then
      out[#out + 1] = flag
    end
  end
  return out
end

local function file_completion(arglead)
  local ok, matches = pcall(vim.fn.getcompletion, arglead, 'file')
  if ok and type(matches) == 'table' then
    return matches
  end
  return {}
end

--- Words of the typed command line, command name first.
local function words_of(cmdline)
  local body = cmdline:gsub('^%s*:?%s*', '')
  local words = {}
  for word in body:gmatch('%S+') do
    words[#words + 1] = word
  end
  return words
end

--- Index of the word being completed (1 = command name).
local function word_index(cmdline, arglead)
  local n = #words_of(cmdline)
  if arglead == '' then
    return n + 1
  end
  return n
end

--- Completion for `:S2S …`: actions, then config subcommands, then flags/files.
function M.dispatch_complete(arglead, cmdline, _)
  local words = words_of(cmdline)
  local index = word_index(cmdline, arglead)
  local action = words[2]

  if index <= 2 then
    return matching(M.actions, arglead)
  end
  if action == 'config' then
    if index == 3 then
      return matching(M.config_subs, arglead)
    end
    local sub = words[3]
    if arglead:sub(1, 2) == '--' and sub then
      return flag_completion('config', sub, arglead)
    end
    return file_completion(arglead)
  end

  local target = ACTION_TARGET[action]
  if target and arglead:sub(1, 2) == '--' then
    local out = flag_completion(target[1], target[2], arglead)
    if #out > 0 then
      return out
    end
  end
  return file_completion(arglead)
end

--- Completion for the camelCase aliases (kept for older muscle memory).
function M.complete(arglead, cmdline, _)
  local name = cmdline:match('^%s*:?%s*(%a+)')
  local group, action = nil, nil
  if name == 'S2sNew' then
    group, action = 'publication', 'new'
  elseif name == 'S2sConfig' then
    local sub = cmdline:match('^%s*:?%s*%a+%s+(%S+)')
    group, action = 'config', sub
  end

  if arglead:sub(1, 2) == '--' and action then
    return flag_completion(group, action, arglead)
  end
  return file_completion(arglead)
end

--- `s2s` on the command line expands to `:S2S` (a user command must start with
--- an uppercase letter, so `:s2s` cannot exist as a command itself).
local ABBREV = [[cnoreabbrev <expr> s2s (getcmdtype() ==# ':' && getcmdline() =~# '^s2s') ? 'S2S' : 's2s']]

---@param enabled boolean|nil
function M.set_abbrev(enabled)
  if enabled then
    pcall(vim.cmd, ABBREV)
  else
    pcall(vim.cmd, 'silent! cunabbrev s2s')
  end
end

--- Define every command. Idempotent; safe to call more than once.
function M.define()
  api.nvim_create_user_command('S2S', function(o)
    s2s().dispatch(o.fargs)
  end, {
    nargs = '*',
    desc = 's2s <upload|propose|preview|publish|revoke|new|config|last|health|help> [args]',
    complete = M.dispatch_complete,
    force = true,
    bar = true,
  })

  for _, entry in ipairs(SIMPLE) do
    api.nvim_create_user_command(entry.name, function()
      local mod = s2s()
      local fn = mod[entry.fn]
      if type(fn) ~= 'function' then
        require('s2s.ui').error('s2s: missing entry point ' .. entry.fn)
        return
      end
      fn()
    end, { nargs = 0, desc = entry.desc, force = true, bar = true })
  end

  api.nvim_create_user_command('S2sNew', function(o)
    s2s().new(o.fargs)
  end, {
    nargs = '*',
    desc = 'alias of :S2S new — args pass through to the binary',
    complete = M.complete,
    force = true,
  })

  api.nvim_create_user_command('S2sConfig', function(o)
    s2s().config(o.fargs)
  end, {
    nargs = '*',
    desc = 'alias of :S2S config — args pass through to the binary',
    complete = M.complete,
    force = true,
  })
end

return M
