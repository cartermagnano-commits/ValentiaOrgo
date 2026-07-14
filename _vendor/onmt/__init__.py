"""
Minimal vendored subset of OpenNMT-py 2.2.0 — just the modules MolScribe's
transformer decoder imports. The full OpenNMT-py 2.x can't be installed on
Python 3.11 (pins torch<2.0), and 3.x drags in torchtext/fasttext/ctranslate2
while changing the module APIs the MolScribe checkpoint was trained against.

Files under modules/ and utils/ are verbatim copies from the OpenNMT-py 2.2.0
sdist (MIT license). decoders/decoder.py is trimmed to DecoderBase only.
"""
