" nvim-s2s — command stubs. Nothing is required until a command is used.
"
" No default keymaps: map your leader at <Plug>(s2s_*).

if exists('g:loaded_s2s')
  finish
endif
let g:loaded_s2s = 1

function! s2s#_upload() abort
  call luaeval('require("s2s").upload()')
endfunction

function! s2s#_propose() abort
  call luaeval('require("s2s").propose()')
endfunction

function! s2s#_preview() abort
  call luaeval('require("s2s").preview()')
endfunction

function! s2s#_publish() abort
  call luaeval('require("s2s").publish()')
endfunction

function! s2s#_revoke() abort
  call luaeval('require("s2s").revoke()')
endfunction

function! s2s#_last() abort
  call luaeval('require("s2s").last()')
endfunction

function! s2s#_health() abort
  call luaeval('require("s2s").health()')
endfunction

function! s2s#_help() abort
  call luaeval('require("s2s").help()')
endfunction

function! s2s#_new(...) abort
  call luaeval('require("s2s").new(_A)', a:000)
endfunction

function! s2s#_config(...) abort
  call luaeval('require("s2s").config(_A)', a:000)
endfunction

function! s2s#_complete(arglead, cmdline, cursorpos) abort
  let l:matches = luaeval('require("s2s.commands").complete(_A[1], _A[2], _A[3])', [a:arglead, a:cmdline, a:cursorpos])
  return type(l:matches) == v:t_list ? l:matches : []
endfunction

command! -bar S2sUpload  call s2s#_upload()
command! -bar S2sPropose call s2s#_propose()
command! -bar S2sPreview call s2s#_preview()
command! -bar S2sPublish call s2s#_publish()
command! -bar S2sRevoke  call s2s#_revoke()
command! -bar S2sLast    call s2s#_last()
command! -bar S2sHealth  call s2s#_health()
command! -bar S2sHelp    call s2s#_help()
command! -nargs=* -complete=customlist,s2s#_complete -bar S2sNew    call s2s#_new(<f-args>)
command! -nargs=* -complete=customlist,s2s#_complete -bar S2sConfig call s2s#_config(<f-args>)

nnoremap <silent> <Plug>(s2s_upload)  <Cmd>S2sUpload<CR>
nnoremap <silent> <Plug>(s2s_propose) <Cmd>S2sPropose<CR>
nnoremap <silent> <Plug>(s2s_preview) <Cmd>S2sPreview<CR>
nnoremap <silent> <Plug>(s2s_publish) <Cmd>S2sPublish<CR>
nnoremap <silent> <Plug>(s2s_revoke)  <Cmd>S2sRevoke<CR>
nnoremap <silent> <Plug>(s2s_new)     <Cmd>S2sNew<CR>
nnoremap <silent> <Plug>(s2s_config)  <Cmd>S2sConfig<CR>
nnoremap <silent> <Plug>(s2s_last)    <Cmd>S2sLast<CR>
nnoremap <silent> <Plug>(s2s_detail)  <Cmd>S2sLast<CR>
nnoremap <silent> <Plug>(s2s_health)  <Cmd>S2sHealth<CR>
nnoremap <silent> <Plug>(s2s_help)    <Cmd>S2sHelp<CR>
