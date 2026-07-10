"""DecoderBase from OpenNMT-py 2.2.0 onmt/decoders/decoder.py, verbatim.

The rest of the original file (RNNDecoderBase etc.) is omitted — it pulls in
onmt.models/onmt.modules imports MolScribe never uses.
"""
import torch.nn as nn


class DecoderBase(nn.Module):
    """Abstract class for decoders.

    Args:
        attentional (bool): The decoder returns non-empty attention.
    """

    def __init__(self, attentional=True):
        super(DecoderBase, self).__init__()
        self.attentional = attentional

    @classmethod
    def from_opt(cls, opt, embeddings):
        """Alternate constructor.

        Subclasses should override this method.
        """

        raise NotImplementedError
