-- s2s/init.lua — public API for nvim-s2s.
--
-- Thin wrapper: build argv, spawn the binary, format the one JSON document.
-- The note file is never read, parsed, or written by this plugin.

local M = {}

local api = vim.api
local uv = vim.uv or vim.loop

local spawn = require('s2s.spawn')
local state = require('s2s.state')
local ui = require('s2s.ui')

local defaults = {
  bin = 's2s',
  cwd = 'auto',
  notify = true,
  open = true,
  copy_cid = false,
  confirm_revoke = true,
  timeout = nil,
}

local opts = vim.deepcopy(defaults)

--- Effective options (health, completion and init all read this).
---@return table
function M.get_opts()
  return opts
end

local function resolve_bin(bin)
  bin = (type(bin) == 'string' and bin ~= '') and bin or 's2s'
  if bin:sub(1, 1) == '/' or bin:match('^%a:[/\\]') then
    return bin
  end
  local resolved = vim.fn.exepath(bin)
  if type(resolved) == 'string' and resolved ~= '' then
    return resolved
  end
  return bin
end

---@param user_opts table|nil
---@return table
function M.setup(user_opts)
  local o = vim.tbl_extend('force', vim.deepcopy(defaults), user_opts or {})
  o.bin = resolve_bin(o.bin)
  opts = o
  pcall(function()
    require('s2s.commands').define()
  end)
  return o
end

local function note_path(buf)
  buf = buf or api.nvim_get_current_buf()
  if not api.nvim_buf_is_valid(buf) then
    return nil
  end
  local name = api.nvim_buf_get_name(buf)
  if type(name) ~= 'string' or name == '' then
    return nil
  end
  return vim.fn.fnamemodify(name, ':p')
end

local function cwd_for(note)
  if type(opts.cwd) == 'string' and opts.cwd ~= 'auto' and opts.cwd ~= '' then
    return opts.cwd
  end
  if note then
    return spawn.resolve_cwd(note)
  end
  return vim.fn.getcwd()
end

-- One WARN per buffer, ever, about frontmatter we refused to reload.
local frontmatter_warned = {}

local function sync_note(buf, result)
  if type(result) ~= 'table' or result.frontmatterWritten ~= true then
    return
  end
  if not buf or not api.nvim_buf_is_valid(buf) then
    return
  end
  if vim.bo[buf].modified then
    if not frontmatter_warned[buf] then
      frontmatter_warned[buf] = true
      ui.warn("s2s: the note's frontmatter changed on disk — `:e!` to take it, or `:w` will clobber it")
    end
    return
  end
  frontmatter_warned[buf] = nil
  pcall(api.nvim_buf_call, buf, function()
    vim.cmd('silent! edit')
  end)
end

-- Only ever open a URL the binary actually returned in render.*.
local function maybe_open(action, result)
  if not opts.open then
    return
  end
  if action ~= 'preview' and action ~= 'publish' then
    return
  end
  local ok, target = pcall(function()
    return require('s2s.format').open_target(result)
  end)
  if not ok or type(target) ~= 'table' or type(target.url) ~= 'string' then
    return
  end
  local render = type(result.render) == 'table' and result.render or {}
  if target.url ~= render.previewUrl and target.url ~= render.prodUrl then
    return
  end
  pcall(vim.ui.open, target.url)
end

local function copy_cid(action, result)
  if not opts.copy_cid or action ~= 'upload' then
    return
  end
  local cid = type(result) == 'table' and result.kuboCid or nil
  if type(cid) == 'string' and cid ~= '' then
    pcall(vim.fn.setreg, '+', cid)
  end
end

local function is_failure(result, code)
  local ok, failed = pcall(function()
    return require('s2s.format').is_failure(result, code)
  end)
  if ok then
    return failed == true
  end
  return code ~= 0 or (type(result) == 'table' and result.ok == false)
end

--- Handle one finished invocation. buf == nil for buffer-less commands.
local function finish(buf, action, started, payload)
  local code = payload.code
  local result = payload.json
  local ms = math.floor((uv.hrtime() - started) / 1e6)

  if buf then
    state.set_busy(buf, false)
  end

  -- Keep failures inspectable: `:S2sLast` is often wanted right after a red
  -- notify, and the envelope (or the "not JSON" diagnostic) is what to read.
  local function remember_failure(stored)
    if not buf then
      return
    end
    if type(stored) ~= 'table' then
      stored = {
        ok = false,
        error = payload.parse_error or string.format('s2s exited %s', tostring(code)),
      }
    end
    state.set(buf, { action = action, result = stored, code = code, at = os.time(), ms = ms })
  end

  if type(result) ~= 'table' then
    ui.failure(buf, action, {
      code = code,
      stderr = payload.stderr,
      parse_error = payload.parse_error or 'not a JSON result — is `bin` the s2s binary?',
      signal = payload.signal,
    })
    remember_failure(nil)
    return
  end

  if code == 0 and not is_failure(result, code) then
    if buf then
      state.set(buf, { action = action, result = result, code = code, at = os.time(), ms = ms })
    end
    if opts.notify then
      ui.result(buf, action, result, code, ms)
    end
    sync_note(buf, result)
    copy_cid(action, result)
    maybe_open(action, result)
    return
  end

  ui.failure(buf, action, {
    code = code,
    result = result,
    stderr = (code == 1 or code == 2) and nil or payload.stderr,
    signal = payload.signal,
  })
  remember_failure(result)
end

local function run(buf, group, action, note)
  buf = buf or api.nvim_get_current_buf()
  local path = note_path(buf)
  if not path then
    ui.warn('s2s: this buffer has no file — save the note first')
    return
  end
  if state.is_busy(buf) then
    ui.warn(string.format('s2s: %s is already running for this buffer', action))
    return
  end

  local started = uv.hrtime()
  local spec = {
    bin = opts.bin,
    group = group,
    action = action,
    note = path,
    cwd = cwd_for(path),
    timeout = opts.timeout,
    buf = buf,
  }

  state.set_busy(buf, true)
  ui.busy(buf, action)
  spawn.run(spec, function(payload)
    finish(buf, action, started, payload)
  end)
end

-- Buffer-less pass-through commands (`publication new`, `config …`).
local function split_args(args)
  if args == nil then
    return {}
  end
  if type(args) == 'table' then
    local out = {}
    for i = 1, #args do
      out[i] = tostring(args[i])
    end
    return out
  end
  local out = {}
  for word in tostring(args):gmatch('%S+') do
    out[#out + 1] = word
  end
  return out
end

local function run_raw(label, group, action, args)
  local argv = split_args(args)
  local started = uv.hrtime()
  local spec = {
    bin = opts.bin,
    group = group,
    action = action,
    args = argv,
    cwd = cwd_for(nil),
    timeout = opts.timeout,
  }

  ui.busy(0, label)
  spawn.run(spec, function(payload)
    finish(nil, label, started, payload)
  end)
end

---@param buf integer|nil
function M.upload(buf)
  run(buf, 'author', 'upload')
end

---@param buf integer|nil
function M.propose(buf)
  run(buf, 'author', 'propose')
end

---@param buf integer|nil
function M.preview(buf)
  run(buf, 'author', 'preview')
end

---@param buf integer|nil
function M.publish(buf)
  run(buf, 'author', 'publish')
end

--- Destructive (retracts on-chain): confirms first, opt-out via confirm_revoke.
---@param buf integer|nil
function M.revoke(buf)
  buf = buf or api.nvim_get_current_buf()
  local function go()
    run(buf, 'author', 'revoke')
  end
  if not opts.confirm_revoke then
    go()
    return
  end
  local name = vim.fn.fnamemodify(api.nvim_buf_get_name(buf), ':t')
  vim.ui.select({ 'Yes, revoke', 'No, cancel' }, {
    prompt = string.format('s2s: revoke %s on-chain?', name ~= '' and name or 'this note'),
  }, function(choice)
    if choice and choice:match('^Yes') then
      go()
    end
  end)
end

--- `:S2sNew <name> --repo <o/r> …` — args go through verbatim.
---@param args string|string[]|nil
function M.new(args)
  local argv = split_args(args)
  local action = table.remove(argv, 1) or 'new'
  run_raw('new', 'publication', action, argv)
end

--- `:S2sConfig <set|get|unset|list|path> …` — args go through verbatim.
---@param args string|string[]|nil
function M.config(args)
  local argv = split_args(args)
  local action = table.remove(argv, 1)
  run_raw('config', 'config', action, argv)
end

---@param buf integer|nil
---@return boolean
function M.last(buf)
  return ui.detail(buf)
end

function M.health()
  local ok = pcall(vim.cmd, 'checkhealth s2s')
  if not ok then
    pcall(function()
      require('s2s.health').check()
    end)
  end
end

function M.help()
  local lines = {
    's2s — Soul2Soul from Neovim (thin wrapper over the s2s binary)',
    '',
    'Commands:',
    '  :S2sUpload    author upload  (IPFS + pins)',
    '  :S2sPropose   author propose (on-chain offer)',
    '  :S2sPreview   author preview (render + URL)',
    '  :S2sPublish   author publish (all-in-one)',
    '  :S2sRevoke    author revoke  (confirms first)',
    '  :S2sNew <name> --repo <o/r> …',
    '  :S2sConfig <set|get|unset|list|path> …',
    '  :S2sLast      last result for this buffer',
    '  :S2sHealth    :checkhealth s2s',
    '  :S2sHelp      this text',
    '',
    'setup():',
    string.format('  bin            = %s', tostring(opts.bin)),
    string.format('  cwd            = %s', tostring(opts.cwd)),
    string.format('  notify         = %s', tostring(opts.notify)),
    string.format('  open           = %s', tostring(opts.open)),
    string.format('  copy_cid       = %s', tostring(opts.copy_cid)),
    string.format('  confirm_revoke = %s', tostring(opts.confirm_revoke)),
    string.format('  timeout        = %s', tostring(opts.timeout)),
    '',
    'No default keymaps — see <Plug>(s2s_*).',
  }
  ui.notify(table.concat(lines, '\n'))
end

return M
