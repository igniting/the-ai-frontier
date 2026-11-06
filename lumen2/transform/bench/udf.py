# python3 udf.py TRANSFORM.py < input > output
# The usual way to run user code in Python: exec the user's file in a
# namespace holding the library, then call its transform on every line.
# Nothing stops the user's code from doing anything Python can do.

import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
namespace = {}
with open(os.path.join(here, 'lib.py')) as f:
    exec(compile(f.read(), 'lib.py', 'exec'), namespace)
with open(sys.argv[1]) as f:
    exec(compile(f.read(), sys.argv[1], 'exec'), namespace)
transform = namespace['transform']

out = sys.stdout
write = out.write
for n, line in enumerate(sys.stdin, 1):
    r = transform(n, line.rstrip('\r\n') if line.endswith('\n') else line)
    if r is not None:
        write(r)
        write('\n')
