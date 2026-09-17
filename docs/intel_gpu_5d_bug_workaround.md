# OpenVINO Intel GPU 5D Tensor Bug Workaround

## The Issue
When running certain ONNX models (specifically those with Fast Fourier Convolutions like LaMA) on Intel GPUs using OpenVINO, you may encounter severe visual artifacts or massive numerical instability. 

This is often caused by a driver-level fusion bug where OpenVINO improperly optimizes `MatMul` operations feeding into `Add` or `Subtract` nodes when the tensors are 5D with a trailing dimension of 1 (e.g., `[1, 192, 33, 64, 1]`). The GPU silently introduces massive numerical errors (differences in the thousands).

## The Fix
Intel GPU kernels are highly optimized and stable for 4D (NCHW) memory layouts. You can permanently fix the broken ONNX model by wrapping the buggy operations in `Squeeze` and `Unsqueeze` nodes to force 4D execution.

### ONNX Python Patcher Script
Use the following Python script to automatically patch your ONNX model. Adjust the `node.op_type` and `node.name` conditions to target the specific failing layers in your architecture.

```python
import onnx
from onnx import helper

# 1. Load the broken model
model_path = "lama_fp32.onnx"
out_path = "lama_fp32_fixed.onnx"
model = onnx.load(model_path)
graph = model.graph

final_nodes = []
mod_count = 0

# 2. Create an initializer for the axes tensor (squeeze the last dimension: -1)
axes_tensor_name = "squeeze_axes"
axes_tensor = helper.make_tensor(axes_tensor_name, onnx.TensorProto.INT64, [1], [-1])
graph.initializer.append(axes_tensor)

# 3. Iterate over the graph and replace buggy nodes
for i, node in enumerate(graph.node):
    # Target Add/Sub nodes involved in complex arithmetic (e.g., inside FFC blocks)
    if node.op_type in ["Sub", "Add"] and "rttn/" in node.name:
        A = node.input[0]
        B = node.input[1]
        out = node.output[0]
        name = node.name
        
        # Define new variable names
        A_sq = A + "_sq"
        B_sq = B + "_sq"
        out_sq = out + "_sq"
        
        # Create Squeeze -> Math -> Unsqueeze chain
        sq_A = helper.make_node("Squeeze", [A, axes_tensor_name], [A_sq], name=name+"_sqA")
        sq_B = helper.make_node("Squeeze", [B, axes_tensor_name], [B_sq], name=name+"_sqB")
        op_sq = helper.make_node(node.op_type, [A_sq, B_sq], [out_sq], name=name+"_opSq")
        unsq_out = helper.make_node("Unsqueeze", [out_sq, axes_tensor_name], [out], name=name+"_unsq")
        
        final_nodes.extend([sq_A, sq_B, op_sq, unsq_out])
        mod_count += 1
    else:
        final_nodes.append(node)

# 4. Replace graph nodes and save
del graph.node[:]
graph.node.extend(final_nodes)
onnx.save(model, out_path)

print(f"Patched {mod_count} operations. Saved to {out_path}")
```
