<!-- Page 1 -->
### Provided proper attribution is provided, Google hereby grants permission to

reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.

## Attention Is All You Need

#### Ashish Vaswani

*∗* **Noam Shazeer** *∗* **Niki Parmar** *∗* **Jakob Uszkoreit** *∗* Google Brain Google Brain Google Research Google Research avaswani@google.com noam@google.com nikip@google.com usz@google.com

#### Llion Jones

*∗* **Aidan N. Gomez** *∗ †* **Łukasz Kaiser** *∗* Google Research University of Toronto Google Brain llion@google.com aidan@cs.toronto.edu lukaszkaiser@google.com

#### Illia Polosukhin

*∗ ‡* illia.polosukhin@gmail.com

### Abstract

The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles, by over 2 BLEU. On the WMT 2014 English-to-French translation task, our model establishes a new single-model state-of-the-art BLEU score of 41.8 after training for 3.5 days on eight GPUs, a small fraction of the training costs of the

# arXiv:1706.03762v7 [cs.CL] 2 Aug 2023

best models from the literature. We show that the Transformer generalizes well to other tasks by applying it successfully to English constituency parsing both with large and limited training data.

*∗* Equal contribution. Listing order is random. Jakob proposed replacing RNNs with self-attention and started the effort to evaluate this idea. Ashish, with Illia, designed and implemented the first Transformer models and has been crucially involved in every aspect of this work. Noam proposed scaled dot-product attention, multi-head attention and the parameter-free position representation and became the other person involved in nearly every detail. Niki designed, implemented, tuned and evaluated countless model variants in our original codebase and tensor2tensor. Llion also experimented with novel model variants, was responsible for our initial codebase, and efficient inference and visualizations. Lukasz and Aidan spent countless long days designing various parts of and implementing tensor2tensor, replacing our earlier codebase, greatly improving results and massively accelerating our research. *†* Work performed while at Google Brain. *‡* Work performed while at Google Research.

31st Conference on Neural Information Processing Systems (NIPS 2017), Long Beach, CA, USA.


<!-- Page 2 -->
### 1 Introduction

Recurrent neural networks, long short-term memory [13] and gated recurrent [7] neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation [35, 2, 5]. Numerous efforts have since continued to push the boundaries of recurrent language models and encoder-decoder architectures [38, 24, 15].

Recurrent models typically factor computation along the symbol positions of the input and output sequences. Aligning the positions to steps in computation time, they generate a sequence of hidden states *ht*, as a function of the previous hidden state *ht−*1and the input for position *t*. This inherently sequential nature precludes parallelization within training examples, which becomes critical at longer sequence lengths, as memory constraints limit batching across examples. Recent work has achieved significant improvements in computational efficiency through factorization tricks [21] and conditional computation [32], while also improving model performance in case of the latter. The fundamental constraint of sequential computation, however, remains.

Attention mechanisms have become an integral part of compelling sequence modeling and transduction models in various tasks, allowing modeling of dependencies without regard to their distance in the input or output sequences [2, 19]. In all but a few cases [27], however, such attention mechanisms are used in conjunction with a recurrent network.

In this work we propose the Transformer, a model architecture eschewing recurrence and instead relying entirely on an attention mechanism to draw global dependencies between input and output. The Transformer allows for significantly more parallelization and can reach a new state of the art in translation quality after being trained for as little as twelve hours on eight P100 GPUs.

### 2 Background

The goal of reducing sequential computation also forms the foundation of the Extended Neural GPU [16], ByteNet [18] and ConvS2S [9], all of which use convolutional neural networks as basic building block, computing hidden representations in parallel for all input and output positions. In these models, the number of operations required to relate signals from two arbitrary input or output positions grows in the distance between positions, linearly for ConvS2S and logarithmically for ByteNet. This makes it more difficult to learn dependencies between distant positions [12]. In the Transformer this is reduced to a constant number of operations, albeit at the cost of reduced effective resolution due to averaging attention-weighted positions, an effect we counteract with Multi-Head Attention as described in section 3.2.

Self-attention, sometimes called intra-attention is an attention mechanism relating different positions of a single sequence in order to compute a representation of the sequence. Self-attention has been used successfully in a variety of tasks including reading comprehension, abstractive summarization, textual entailment and learning task-independent sentence representations [4, 27, 28, 22].

End-to-end memory networks are based on a recurrent attention mechanism instead of sequence- aligned recurrence and have been shown to perform well on simple-language question answering and language modeling tasks [34].

To the best of our knowledge, however, the Transformer is the first transduction model relying entirely on self-attention to compute representations of its input and output without using sequence- aligned RNNs or convolution. In the following sections, we will describe the Transformer, motivate self-attention and discuss its advantages over models such as [17, 18] and [9].

### 3 Model Architecture

Most competitive neural sequence transduction models have an encoder-decoder structure [5, 2, 35]. Here, the encoder maps an input sequence of symbol representations (*x₁,...,xn*) to a sequence of continuous representations z = (*z₁,...,zn*). Given z, the decoder then generates an output sequence (*y₁,...,ym*) of symbols one element at a time. At each step the model is auto-regressive [10], consuming the previously generated symbols as additional input when generating the next.


<!-- Page 6 -->
Table 1: Maximum path lengths, per-layer complexity and minimum number of sequential operations

for different layer types. *n* is the sequence length, *d* is the representation dimension, *k* is the kernel size of convolutions and *r* the size of the neighborhood in restricted self-attention.

|Layer Type|Complexity per Layer|Sequential|Maximum Path Length|
|---|---|---|---|
|||Operations||
|Self-Attention|O ( n² · d|) O (1)|O (1)|
|Recurrent|O ( n · d²|) O ( n|) O ( n )|
|Convolutional|O ( k · n · d²|) O (1)|O ( log k ( n ))|
|Self-Attention (restricted)|O ( r · n · d|) O (1)|O ( n/r )|

#### 3.5 Positional Encoding

Since our model contains no recurrence and no convolution, in order for the model to make use of the order of the sequence, we must inject some information about the relative or absolute position of the tokens in the sequence. To this end, we add "positional encodings" to the input embeddings at the bottoms of the encoder and decoder stacks. The positional encodings have the same dimension *d*model as the embeddings, so that the two can be summed. There are many choices of positional encodings, learned and fixed [9].

In this work, we use sine and cosine functions of different frequencies:

*PE*(*pos,*2*i*)= *sin*(*pos/*10000 2*i/d*model )

*PE*(*pos,*2*i*+1)= *cos*(*pos/*10000 2*i/d*model )

where *pos* is the position and *i* is the dimension. That is, each dimension of the positional encoding corresponds to a sinusoid. The wavelengths form a geometric progression from 2*π* to 10000*·* 2*π*. We chose this function because we hypothesized it would allow the model to easily learn to attend by relative positions, since for any fixed offset *k*, *PEpos*+*k*can be represented as a linear function of *PEpos*.

We also experimented with using learned positional embeddings [9] instead, and found that the two versions produced nearly identical results (see Table 3 row (E)). We chose the sinusoidal version because it may allow the model to extrapolate to sequence lengths longer than the ones encountered during training.

### 4 Why Self-Attention

In this section we compare various aspects of self-attention layers to the recurrent and convolutional layers commonly used for mapping one variable-length sequence of symbol representations
(*x₁,...,xn*) to another sequence of equal length (*z₁,...,zn*), with *xi,zi∈* R
*d*, such as a hidden layer in a typical sequence transduction encoder or decoder. Motivating our use of self-attention we consider three desiderata.

One is the total computational complexity per layer. Another is the amount of computation that can be parallelized, as measured by the minimum number of sequential operations required.

The third is the path length between long-range dependencies in the network. Learning long-range dependencies is a key challenge in many sequence transduction tasks. One key factor affecting the ability to learn such dependencies is the length of the paths forward and backward signals have to traverse in the network. The shorter these paths between any combination of positions in the input and output sequences, the easier it is to learn long-range dependencies [12]. Hence we also compare the maximum path length between any two input and output positions in networks composed of the different layer types.

As noted in Table 1, a self-attention layer connects all positions with a constant number of sequentially executed operations, whereas a recurrent layer requires *O*(*n*) sequential operations. In terms of computational complexity, self-attention layers are faster than recurrent layers when the sequence


<!-- Page 8 -->
Table 2: The Transformer achieves better BLEU scores than previous state-of-the-art models on the

<u>English-to-German and English-to-French newstest2014 tests at a fraction of the training cost.</u>

||BLEU||Training Cost (FLOPs)|||
|---|---|---|---|---|---|
|Model|EN-DE|EN-FR|EN-DE||EN-FR|
|ByteNet [18]|23.75|||||
|Deep-Att + PosUnk [39]||39.2|||1.0 · 10|
|GNMT + RL [38]|24.6|39.92|2.3 · 10||1.4 · 10|
|ConvS2S [9]|25.16|40.46|9.6 · 10||1.5 · 10|
|MoE [32]|26.03|40.56|2.0 · 10||1.2 · 10|
|Deep-Att + PosUnk Ensemble [39]||40.4|||8.0 · 10|
|GNMT + RL Ensemble [38]|26.30|41.16|1.8 · 10||1.1 · 10|
|ConvS2S Ensemble [9]|26.36|41.29|7.7 · 10||1.2 · 10|
|Transformer (base model)|27.3|38.1||3.3 · 10||
|Transformer (big)|28.4|41.8||2.3 · 10||

20 19 20 18 20 19 20 20 20 21 19 21 18 19

**Residual Dropout** We apply dropout [33] to the output of each sub-layer, before it is added to the sub-layer input and normalized. In addition, we apply dropout to the sums of the embeddings and the positional encodings in both the encoder and decoder stacks. For the base model, we use a rate of *Pdrop*= 0*.*1.

**Label Smoothing** During training, we employed label smoothing of value *ϵls*= 0*.*1 [36]. This hurts perplexity, as the model learns to be more unsure, but improves accuracy and BLEU score.

### 6 Results

#### 6.1 Machine Translation

On the WMT 2014 English-to-German translation task, the big transformer model (Transformer (big) in Table 2) outperforms the best previously reported models (including ensembles) by more than 2*.*0 BLEU, establishing a new state-of-the-art BLEU score of 28*.*4. The configuration of this model is listed in the bottom line of Table 3. Training took 3*.*5 days on 8 P100 GPUs. Even our base model surpasses all previously published models and ensembles, at a fraction of the training cost of any of the competitive models.

On the WMT 2014 English-to-French translation task, our big model achieves a BLEU score of 41*.*0, outperforming all of the previously published single models, at less than 1*/*4 the training cost of the previous state-of-the-art model. The Transformer (big) model trained for English-to-French used dropout rate *Pdrop*= 0*.*1, instead of 0*.*3.

For the base models, we used a single model obtained by averaging the last 5 checkpoints, which were written at 10-minute intervals. For the big models, we averaged the last 20 checkpoints. We used beam search with a beam size of 4 and length penalty *α* = 0*.*6 [38]. These hyperparameters were chosen after experimentation on the development set. We set the maximum output length during inference to input length + 50, but terminate early when possible [38].

Table 2 summarizes our results and compares our translation quality and training costs to other model

architectures from the literature. We estimate the number of floating point operations used to train a model by multiplying the training time, the number of GPUs used, and an estimate of the sustained single-precision floating-point capacity of each GPU 5.

#### 6.2 Model Variations

To evaluate the importance of different components of the Transformer, we varied our base model in different ways, measuring the change in performance on English-to-German translation on the

We used values of 2.8, 3.7, 6.0 and 9.5 TFLOPS for K80, K40, M40 and P100, respectively.

<!-- Page 16 -->
1 **Appendix A: Synthetic Anchoring Supplement** 2 SYNTHETIC FIXTURE AUTHORS AND AFFILIATIONS 3 4 This supplemental page is a synthetic construction that reproduces the review-stage gutter layout, which 5 camera-ready formats omit before publication. The numbered gutter along the left edge interleaves line 6 digits into the projected reading order, while the geometric page stream omits them entirely, and every 7 anchoring decision must tolerate that divergence without silently drifting onto a neighboring line. 8 9 Interleaved digits stress the sequential alignment walk [1, 2] because a pure digit run exists nowhere on the 10 page and must be stepped over so the prose after it still anchors [3]. Coverage thresholds absorb a 11 bounded amount of this noise, but a genuine reordering of table cells still degrades the affected quote to 12 page level rather than anchoring it onto the wrong glyphs. 13 14 Across the pilot sessions this design reduced the annotation workload to **sixteen verbatim quotes per** 15 **annotator** in every session, a pace that kept the coders attentive while still finishing each batch within one 16 afternoon. 17 18 A deliberate hyphenation across the line boundary, as in interleaved- 19 digits and margin-aware spans, must reunify during normalization so that a quote copied from either view resolves to the same page span. 20 21 The remaining rows are filler prose so that every numbered line of the gutter has body text at the same 22 height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic 23 weight; it exists so the geometry stays dense. 24 25 Filler passage 1: the gutter keeps counting while the body keeps wrapping, and the alignment keeps 26 walking. The remaining rows are filler prose so that every numbered line of the gutter has body text at the 27 same height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic 28 weight; it exists so the geometry stays dense. 29 30 Filler passage 2: the gutter keeps counting while the body keeps wrapping, and the alignment keeps 31 walking. The remaining rows are filler prose so that every numbered line of the gutter has body text at the 32 same height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic 33 weight; it exists so the geometry stays dense. 34 35 Filler passage 3: the gutter keeps counting while the body keeps wrapping, and the alignment keeps 36 walking. The remaining rows are filler prose so that every numbered line of the gutter has body text at the 37 same height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic 38 weight; it exists so the geometry stays dense. 39 40 Filler passage 4: the gutter keeps counting while the body keeps wrapping, and the alignment keeps 41 walking. The remaining rows are filler prose so that every numbered line of the gutter has body text at the 42 same height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic 43 weight; it exists so the geometry stays dense. 44 45 Filler passage 5: the gutter keeps counting while the body keeps wrapping, and the alignment keeps 46 walking. The remaining rows are filler prose so that every numbered line of the gutter has body text at the 47 same height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic 48 weight; it exists so the geometry stays dense. 49 50 Filler passage 6: the gutter keeps counting while the body keeps wrapping, and the alignment keeps 51 walking. The remaining rows are filler prose so that every numbered line of the gutter has body text at the 52 same height, keeping the extraction order stable across viewers. Nothing in this paragraph carries semantic

