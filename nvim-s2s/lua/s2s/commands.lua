-- s2s/commands.lua — the only module that defines :S2s* commands.
-- Every command body requires s2s lazily: nothing runs at startup.

local M = {}

local api = vim.api

local function s2s()
  return require('s2s')
end

local SIMPLE = {
  { name = 'S2sUpload', fn = 'upload', desc = 's2s: author upload (IPFS + pins)' },
  { name = 'S2sPropose', fn = 'propose', desc = 's2s: author propose (on-chain offer)' },
  { name = 'S2sPreview', fn = 'preview', desc = 's2s: author preview (render + URL)' },
  { name = 'S2sPublish', fn = 'publish', desc = 's2s: author publish (all-in-one)' },
  { name = 'S2sRevoke', fn = 'revoke', desc = 's2s: author revoke (confirms first)' },
  { name = 'S2sLast', fn = 'last', desc = 's2s: last result for this buffer' },
  { name = 'S2sHealth', fn = 'health', desc = 's2s: health check (see :checkhealth s2s)' },
  { name = 'S2sHelp', fn = 'help', desc = 's2s: options and commands' },
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

local function cmd_name(cmdline)
  return (cmdline:match('^%s*:?%s*(%a+)'))
end

--- Completion for :S2sNew and :S2sConfig — flags from the binary, else files.
function M.complete(arglead, cmdline, _)
  local name = cmd_name(cmdline)
  local group, action = nil, nil
  if name == 'S2sNew' then
    group, action = 'publication', 'new'
  elseif name == 'S2sConfig' then
    local sub = cmdline:match('^%s*:?%s*%a+%s+(%S+)')
    group, action = 'config', sub
  end

  if arglead:sub(1, 2) == '--' and action then
    local out = {}
    for _, flag in ipairs(flags_for(group, action)) do
      if flag:sub(1, #arglead) == arglead then
        out[#out + 1] = flag
      end
    end
    return out
  end

  local ok, matches = pcall(vim.fn.getcompletion, arglead, 'file')
  if ok and type(matches) == 'table' then
    return matches
  end
  return {}
end

--- Define every command. Idempotent; safe to call more than once.
function M.define()
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
    desc = 's2s: publication new — args pass through to the binary',
    complete = M.complete,
    force = true,
  })

  api.nvim_create_user_command('S2sConfig', function(o)
    s2s().config(o.fargs)
  end, {
    nargs = '*',
    desc = 's2s: config set|get|unset|list|path — args pass through to the binary',
    complete = M.complete,
    force = true,
  })
end

return M
