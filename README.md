# VSCode HLint

[![Build Status](https://travis-ci.org/lunaryorn/vscode-hlint.svg?branch=master)](https://travis-ci.org/lunaryorn/vscode-hlint)

Lint Haskell code with [HLint][] in [Visual Studio Code][code].

[HLint]: https://github.com/ndmitchell/hlint
[code]: https://code.visualstudio.com

## Prerequisites

`hlint` **2.0.8** or newer must be available in `$PATH`.  HLint 1.9.25 and upwards should work too, but I'm not testing it.  HLint 2.0.0 to 2.0.7 do **not** work—these versions can't read code from standard input.

To apply suggestions `refactor` from [apply-refact][] must be in `$PATH` as well.

[apply-refact]: https://github.com/mpickering/apply-refact

## Usage

Just open or save a Haskell file.  HLint will automatically check your file.

In some cases HLint can automatically fix issues.  In these cases a [code action][] is available on the problematic expression; just click on the light bulb in the left margin.

**Note:** By default most HLint hints are "suggestions".  VSCode doesn't show these in the editor; you'll need to summon the "Problems" window explicitly to see those.  You can [configure HLint][1] to change the severity of hints if you like.

[1]: https://github.com/ndmitchell/hlint#customizing-the-hints
[code action]: https://code.visualstudio.com/docs/editor/editingevolved#_code-action

## Prior Art

[Haskell Linter](https://github.com/hoovercj/vscode-haskell-linter).

I wrote this extension because the above does not currently work with HLint 2, and I found the implementation overly verbose and clumsy when trying to address the issue.  If I may say this extension has the better code: Less mutable state, much simpler implementation, and better documentation :blush:  It also uses `refactor` to apply HLint suggestions instead of text replacement.

## License

Copyright © 2017  Sebastian Wiesner <swiesner@lunaryorn.com>

vscode-hlint is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

vscode-hlint is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with vscode-hlint.  If not, see <http://www.gnu.org/licenses/>.
