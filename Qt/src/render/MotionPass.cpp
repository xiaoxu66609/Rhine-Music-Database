#include <QtGlobal>
#include "MotionPass.h"
#include <QFile>
#include <QJsonArray>
#include <cmath>
#include <cstring>

namespace RhineRender {
namespace {
QShader loadShader(const QString &name) {
    QFile file(":/shaders/" + name + ".qsb");
    if (!file.open(QIODevice::ReadOnly)) {
        qFatal("Missing motion shader: %s", qPrintable(name));
    }
    return QShader::fromSerialized(file.readAll());
}
QMatrix4x4 matrix(const QJsonValue &value) {
    QMatrix4x4 result;
    const auto values = value.toArray();
    for (int index = 0; index < 16 && index < values.size(); ++index) {
        result.data()[index] = float(values[index].toDouble());
    }
    return result;
}
QByteArray pairedMatrices(const QByteArray &current, const QByteArray &previous) {
    QHash<QByteArray, int> translations;
    if (current.size() > 64 || previous.size() > 64) {
        for (int index = 0; (index + 1) * 64 <= previous.size(); ++index) {
            translations.insert(previous.mid(index * 64 + 48, 16), index);
        }
    }
    QByteArray result;
    result.reserve(current.size() * 2);
    for (int index = 0; (index + 1) * 64 <= current.size(); ++index) {
        const auto model = current.mid(index * 64, 64);
        result.append(model);
        const int match = translations.isEmpty() ? index : translations.value(model.mid(48, 16), -1);
        result.append(match >= 0 && (match + 1) * 64 <= previous.size() ? previous.mid(match * 64, 64)
                                                                        : model);
    }
    return result;
}
} // namespace

void MotionPass::resize(QSize dimensions) {
    if (m_size == dimensions) {
        return;
    }
    m_size = dimensions;
    m_instances.clear();
    m_previousModels.clear();
    resources.clear();
    sized.clear();
    m_historyValid = false;
    m_pipelines[0] = nullptr;
    m_pipelines[1] = nullptr;
    m_depth = texture(m_size, QRhiTexture::D32F, QRhiTexture::RenderTarget);
    m_vectors = texture(m_size, QRhiTexture::RGBA16F, QRhiTexture::RenderTarget);
    QRhiTextureRenderTargetDescription description{QRhiColorAttachment(m_vectors)};
    description.setDepthTexture(m_depth);
    m_target = own(rhi->newTextureRenderTarget(description));
    auto pass = own(m_target->newCompatibleRenderPassDescriptor());
    m_target->setRenderPassDescriptor(pass);
    create(m_target);
    m_globals = create(own(rhi->newBuffer(QRhiBuffer::Dynamic, QRhiBuffer::UniformBuffer, 544)));
    m_bindings = own(rhi->newShaderResourceBindings());
    m_bindings->setBindings({QRhiShaderResourceBinding::uniformBuffer(
        0, QRhiShaderResourceBinding::VertexStage | QRhiShaderResourceBinding::FragmentStage, m_globals)});
    create(m_bindings);
}

QRhiGraphicsPipeline *MotionPass::pipeline(bool doubleSided) {
    auto &result = m_pipelines[doubleSided ? 1 : 0];
    if (result) {
        return result;
    }
    result = own(rhi->newGraphicsPipeline());
    result->setShaderStages({{QRhiShaderStage::Vertex, loadShader("motion.vert")},
                             {QRhiShaderStage::Fragment, loadShader("velocity.frag")}});
    QRhiVertexInputLayout layout;
    layout.setBindings({{32}, {128, QRhiVertexInputBinding::PerInstance}});
    QList<QRhiVertexInputAttribute> attributes{{0, 0, QRhiVertexInputAttribute::Float3, 0},
                                               {0, 1, QRhiVertexInputAttribute::Float3, 12},
                                               {0, 2, QRhiVertexInputAttribute::Float2, 24}};
    for (int column = 0; column < 8; ++column) {
        attributes.append({1, 3 + column, QRhiVertexInputAttribute::Float4, quint32(column * 16)});
    }
    layout.setAttributes(attributes.cbegin(), attributes.cend());
    result->setVertexInputLayout(layout);
    result->setCullMode(doubleSided ? QRhiGraphicsPipeline::None : QRhiGraphicsPipeline::Back);
    result->setDepthTest(true);
    result->setDepthWrite(true);
    result->setDepthOp(QRhiGraphicsPipeline::LessOrEqual);
    result->setShaderResourceBindings(m_bindings);
    result->setRenderPassDescriptor(m_target->renderPassDescriptor());
    return create(result);
}

void MotionPass::render(QRhiCommandBuffer *commands, QSize dimensions, const QJsonObject &frame,
                        const QList<MotionDraw> &draws, RhineFg::FrameInputs *output, QSize display) {
    transient.clear();
    resize(dimensions);
    ++generation;
    if (frame["temporalReset"].toBool()) {
        m_previousModels.clear();
        m_historyValid = false;
    }
    const auto view = matrix(frame["view"]);
    auto projection = matrix(frame["projection"]);
    const auto jitterValues = frame["jitter"].toArray();
    const QPointF jitter = jitterValues.size() == 2
                               ? QPointF(jitterValues[0].toDouble(), jitterValues[1].toDouble())
                               : QPointF();
    const auto unjittered = projection * view;
    applyJitter(projection, jitter, dimensions);
    QByteArray uniform(544, '\0');
    std::memcpy(uniform.data(), view.constData(), 64);
    std::memcpy(uniform.data() + 64, projection.constData(), 64);
    const auto previous = m_historyValid ? m_previousViewProjection : unjittered;
    std::memcpy(uniform.data() + 128, previous.constData(), 64);
    // 速度用未抖动当前投影，光栅位置仍使用带抖动投影，避免把采样相位误当几何运动。
    std::memcpy(uniform.data() + 192, unjittered.constData(), 64);
    const auto correction = rhi->clipSpaceCorrMatrix();
    std::memcpy(uniform.data() + 464, correction.constData(), 64);
    updates = rhi->nextResourceUpdateBatch();
    updates->updateDynamicBuffer(m_globals, 0, uniform.size(), uniform.constData());
    QList<QRhiBuffer *> buffers;
    for (const auto &draw : draws) {
        auto &state = m_instances[draw.id];
        if (state.used != generation) {
            dynamicBuffer(state, pairedMatrices(draw.matrices, m_previousModels.value(draw.id)),
                          QRhiBuffer::VertexBuffer);
        }
        buffers.append(state.buffer);
    }
    commands->resourceUpdate(updates);
    updates = nullptr;
    commands->beginPass(m_target, Qt::black, {1, 0});
    // 几何剔除：相机与某个 draw 的模型矩阵都没变时，它的屏幕空间速度恒为零，
    // 清屏后的零值就是正确答案，不必再栅格化一遍。105 万三角形里大部分是静态场景，
    // 省掉它们能直接砍掉运动矢量 pass 的几何开销（实测：这一项与分辨率无关）。
    const bool cameraStatic = m_historyValid && unjittered == m_previousViewProjection;
    int skippedDraws = 0;
    for (int index = 0; index < draws.size(); ++index) {
        const auto &draw = draws[index];
        const auto previousModel = m_previousModels.constFind(draw.id);
        if (cameraStatic && previousModel != m_previousModels.constEnd() &&
            previousModel.value() == draw.matrices) {
            ++skippedDraws;
            continue;
        }
        commands->setGraphicsPipeline(pipeline(draw.doubleSided));
        commands->setShaderResources(m_bindings);
        commands->setViewport({0, 0, float(m_size.width()), float(m_size.height())});
        const QRhiCommandBuffer::VertexInput inputs[]{{draw.vertices, 0}, {buffers[index], 0}};
        commands->setVertexInput(0, 2, inputs, draw.indices, 0, QRhiCommandBuffer::IndexUInt32);
        if (draw.indices) {
            commands->drawIndexed(draw.verticesCount, draw.instancesCount, draw.first);
        } else {
            commands->draw(draw.verticesCount, draw.instancesCount, draw.first);
        }
    }
    commands->endPass();
    m_previousModels.clear();
    for (const auto &draw : draws) {
        m_previousModels.insert(draw.id, draw.matrices);
    }
    for (auto iterator = m_instances.begin(); iterator != m_instances.end();) {
        if (iterator->used != generation) {
            retire(iterator->buffer);
            iterator = m_instances.erase(iterator);
        } else {
            ++iterator;
        }
    }
    m_previousViewProjection = unjittered;
    m_historyValid = true;
    if (output) {
        RhineFg::FrameInputs inputs;
        inputs.depth = m_depth;
        inputs.motionVectors = m_vectors;
        inputs.renderSize = dimensions;
        inputs.displaySize = display;
        inputs.jitter = jitter;
        inputs.reset = frame["temporalReset"].toBool();
        inputs.frameTimeMs = m_clock.isValid() ? float(m_clock.nsecsElapsed()) / 1e6f : 16.6667f;
        m_clock.start();
        const auto originalProjection = matrix(frame["projection"]);
        const float c = originalProjection(2, 2);
        const float translation = originalProjection(2, 3);
        if (std::abs(c - 1.f) > 1e-6f && std::abs(c + 1.f) > 1e-6f) {
            inputs.nearPlane = translation / (c - 1.f);
            inputs.farPlane = translation / (c + 1.f);
        }
        inputs.fovYRadians = 2.f * std::atan(1.f / originalProjection(1, 1));
        inputs.serial = output->serial + 1;
        *output = inputs;
    }
}
} // namespace RhineRender
