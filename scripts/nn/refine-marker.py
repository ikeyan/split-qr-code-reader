"""Fine-tune only the marker classification output with reviewed photo patches."""
import argparse
import base64
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn.functional import binary_cross_entropy_with_logits, linear

from train import marker_data


def patches(directory):
    files = sorted(directory.glob("*.f32"))
    if not files:
        raise ValueError(f"No mined marker patches in {directory}")
    arrays = [np.fromfile(file, dtype="<f4").reshape(-1, 1024) for file in files]
    return torch.from_numpy(np.concatenate(arrays))


def weights(value, shape):
    return torch.from_numpy(
        np.frombuffer(base64.b64decode(value), dtype="<f4").copy().reshape(shape)
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("train", type=Path)
    parser.add_argument("holdout", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    torch.manual_seed(47103)
    model = json.loads(args.baseline.read_text())
    layers = model["marker"]["layers"]
    matrices = [weights(l["weights"], (l["output"], l["input"])) for l in layers]
    offsets = [weights(l["bias"], (l["output"],)) for l in layers]

    def features(pixels):
        for matrix, offset in zip(matrices[:-1], offsets[:-1]):
            pixels = linear(pixels, matrix, offset).relu()
        return pixels

    training = patches(args.train)
    evaluation = patches(args.holdout)
    replay, labels = marker_data(16384, 78991)
    validation, expected = marker_data(4096, 53962)
    known = torch.from_numpy(replay)
    truth = torch.from_numpy(labels[:, 6].copy())
    positives = torch.from_numpy(validation[expected[:, 6] == 1])

    w, b = matrices[-1][-1:], offsets[-1][-1:]

    def baseline(pixels):
        return linear(features(pixels), w, b).flatten()

    # Reserve new hidden units for the classifier. The old pose computation
    # and marker network are embedded unchanged in the exported weights.
    residual = nn.Sequential(
        nn.Linear(1024, 32), nn.ReLU(), nn.Linear(32, 16), nn.ReLU(), nn.Linear(16, 1)
    )
    nn.init.zeros_(residual[-1].weight)
    nn.init.zeros_(residual[-1].bias)
    original_train = baseline(training)
    original_known = baseline(known)
    optimizer = torch.optim.AdamW(residual.parameters(), lr=.001)
    for _ in range(1400):
        i = torch.randint(len(known), (512,))
        j = torch.randint(len(training), (256,))
        known_delta = residual(known[i]).flatten()
        replay_logits = original_known[i] + known_delta
        real = original_train[j] + residual(training[j]).flatten()
        anchors = (truth[i] == 1) & (original_known[i] > 0)
        loss = (
            nn.functional.softplus(real + 1).mean()
            + 3 * binary_cross_entropy_with_logits(replay_logits, truth[i])
            + known_delta[anchors].clamp(max=0).square().mean() * .85
        )
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

    # Calibrate on the synthetic curved QR development cases.
    strength = .2
    with torch.no_grad():
        negative_before = baseline(evaluation)
        negative_after = negative_before + strength * residual(evaluation).flatten()
        positive_before = baseline(positives)
        positive_after = positive_before + strength * residual(positives).flatten()
        for threshold in [0, 1]:
            print(json.dumps({
                "threshold": threshold,
                "holdout_negative_patches": len(evaluation),
                "false_markers_before": int((negative_before >= threshold).sum()),
                "false_markers_after": int((negative_after >= threshold).sum()),
                "synthetic_positive_patches": len(positives),
                "synthetic_accepted_before": int((positive_before >= threshold).sum()),
                "synthetic_accepted_after": int((positive_after >= threshold).sum()),
            }))

        extra = [layer for layer in residual if isinstance(layer, nn.Linear)]
        matrices[0] = torch.cat([matrices[0], extra[0].weight])
        offsets[0] = torch.cat([offsets[0], extra[0].bias])
        matrices[1] = torch.block_diag(matrices[1], extra[1].weight)
        offsets[1] = torch.cat([offsets[1], extra[1].bias])
        extra_output = torch.zeros((7, extra[2].in_features))
        extra_output[-1] = strength * extra[2].weight
        matrices[2] = torch.cat([matrices[2], extra_output], dim=1)
        offsets[2][-1] += strength * extra[2].bias[0]

    for layer, matrix, offset in zip(layers, matrices, offsets):
        layer["input"] = matrix.shape[1]
        layer["output"] = matrix.shape[0]
        for key, values in [("weights", matrix), ("bias", offset)]:
            layer[key] = base64.b64encode(values.numpy().astype("<f4").tobytes()).decode()
    args.output.write_text(json.dumps(model, separators=(",", ":")))


if __name__ == "__main__":
    main()
