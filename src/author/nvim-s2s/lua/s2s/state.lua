-- s2s/state.lua — UI state only: last result per buffer + busy flags.
-- Dropped when the buffer is wiped out.

local M = {}

local last = {}
local busy = {}

local attached = false

local function attach()
  if attached then
    return
  end
  attached = true
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = vim.api.nvim_create_augroup('s2s_state', { clear = true }),
    desc = 's2s: drop per-buffer UI state',
    callback = function(args)
      last[args.buf] = nil
      busy[args.buf] = nil
    end,
  })
end

--- Store the last result for a buffer.
---@param buf integer
---@param entry { action: string, result: table, code: integer, at: integer, ms: integer|nil }
function M.set(buf, entry)
  if not buf or buf <= 0 then
    return
  end
  attach()
  last[buf] = entry
end

---@param buf integer
---@return table|nil
function M.get(buf)
  return last[buf or 0]
end

---@param buf integer
function M.clear(buf)
  last[buf or 0] = nil
  busy[buf or 0] = nil
end

---@param buf integer
---@param value boolean
function M.set_busy(buf, value)
  if not buf or buf <= 0 then
    return
  end
  attach()
  busy[buf] = value and true or nil
end

---@param buf integer
---@return boolean
function M.is_busy(buf)
  return busy[buf or 0] == true
end

return M
