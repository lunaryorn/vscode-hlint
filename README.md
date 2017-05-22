# hlint README

Lint Haskell code with [Hlint][] 2.

[hlint]: https://github.com/ndmitchell/hlint

## Prerequisites

`hlint` (version 2 or newer) must be available in `$PATH`.

To apply suggestions `refactor` from [apply-refact][] must be in `$PATH` as
well.

[apply-refact]: https://github.com/mpickering/apply-refact

## Usage

Just open or save a Haskell file.  Hlint will automatically check your file.

In some cases hlint can automatically fix issues.  In these cases a [code
action][] is available on the problematic expression; just click on the light
bulb in the left margin.

**Note:** By default most Hlint hints are "suggestions".  VSCode doesn't show
these in the editor; you'll need to summon the "Problems" window explicitly to
see those.  You can [configure hlint][1] to change the severity of hints if you
like.

[1]: https://github.com/ndmitchell/hlint#customizing-the-hints
[code action]: https://code.visualstudio.com/docs/editor/editingevolved#_code-action

## Prior Art

[Haskell Linter](https://github.com/hoovercj/vscode-haskell-linter).

I wrote this extension because the above does not currently work with Hlint 2,
and I found the implementation overly verbose and clumsy when trying to address
the issue.  If I may say this extension has the better code: Less mutable state,
much simpler implementation, and better documentation :blush:  It also uses
`refactor` to apply hlint suggestions instead of text replacement.

On the other hand this extension doesn't lint while you're typing, but only 
when the document is saved which suits me just fine :)

## License

Copyright (C) 2017  Sebastian Wiesner <swiesner@lunaryorn.com>

vscode-hlint is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

vscode-hlint is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
vscode-hlint.  If not, see <http://www.gnu.org/licenses/>.
