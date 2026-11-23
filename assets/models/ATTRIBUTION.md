# VA 内置模型

## VA 封面角色

`VA Cover.vrm` 以项目自己的封面为设计来源。用内置图像生成工具补全正面全身参考，在本机用 TripoSR 重建三维网格，再将参考图细节烘焙到 UV 贴图。服装背面和图中未展示的结构由重建补全。网格在 Blender 中清理并绑定 VRM 人形骨骼、口型和表情。[原始封面](../app-icon.png) · [全身建模参考](../../docs/gallery/cover-design.png) · [TripoSR](https://github.com/VAST-AI-Research/TripoSR)

参考图的生成提示保留原封面的尖下巴、青绿色眼睛、银蓝双侧卷发、银叶珍珠发夹、刺绣白色高领和深蓝围巾。全身采用修长的二次元游戏角色比例、正交正面、自然 A 字站姿、等光照和透明背景。

为避免透明参考图的边缘颜色被投影到模型，轮廓贴图用实色区域重新取样。主体材质保留贴图里的光影，移除额外的镜面反射。

背面用内置 ImageGen 参照原封面和全身设计补画正交背视图。参考图延续冰蓝双侧卷发、深蓝围巾、白色毛领和银叶刺绣，补出了后领、衣片接缝和靴后细节。背面颜色重新烘焙到已有 UV，同时补了带骨骼的五指、腿根内侧和逐渐收尖的发束。[背面建模参考](../../docs/gallery/cover-design-back.png)

眼部直接从正面设计重新投影虹膜和睫毛。头顶按参考轮廓收圆，新增细小顶发，并沿参考中的弧线重建右脸旁的发束。

头部以原设计的单独裁图做高分辨率三维重建，保留卷发之间的开口，再按正反面参考着色。眨眼、表情和口型转移到新网格。深蓝裤装从腰到靴口使用一体网格，髋、膝之间使用连续的蒙皮权重。

从九十度侧面修整后脑轮廓，补出逐渐收窄的发根。发根底部藏在立领内，蒙皮权重从头部过渡到颈部。侧面纹理按背面参考的发束方向重新烘焙。

用内置 ImageGen 从原封面和正背设定补画两张九十度全身侧视图。侧稿要求紧凑的后脑、贴近头骨的卷发和向立领收窄的发根。模型以鼻尖对齐侧稿，用两侧轮廓校正后脑的厚度，并采样没有卷心和饰物遮挡的侧面发纹。[面朝左](../../docs/gallery/cover-design-facing-left.png) · [面朝右](../../docs/gallery/cover-design-facing-right.png)

靴子按侧稿补了靴跟和前掌鞋底，并重新分配脚踝以下的蒙皮权重。侧面发顶以前后主体高度校正，口型通过各元音的 VRM 绑定权重收小开口。

说话时，唇线沿连续的形变展开成横向椭圆，唇缘和口腔阴影共同随元音变化。

## Gemini

模型来自 ApprenTice 发布的「AI 娘全家桶」，原角色设计来自 ZipZipPipe 的《大 AI 与小 AI 们》。VA 收录了原包 `04_Gemini_V2/model.glb`，仅更改文件名。预览时在 VA 内旋转到正面，模型数据保持原样。

- [模型包原帖（模之屋）](https://www.aplaybox.com/details/model/3uR3BbUTlkUW)
- [CC BY-NC-SA 4.0 署名、非商业性使用、相同方式共享](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)

## 原包署名说明

## 作者：

[ApprenTice](<https://space.bilibili.com/634972797>)

## images

`images` 中的内容为纯粹的粉丝二次创作，所有角色形象均为虚构的拟人化创作，与各 AI 产品官方立场、运营主体及相关公司无任何关联，不代表对任何 AI 产品的商业评价或技术评测。

`images` 中由本人基于原作创作的角色改编图像，依 CC BY-NC-SA 4.0 授权；转载请保留署名、来源及许可证信息，二次创作须遵循相同许可证。

原作为 [ZipZipPipe](<https://space.bilibili.com/4168597>) 的[《大 AI 与小 AI 们》](<https://www.bilibili.com/video/BV1tE9XBbErS/>)，其版权声明为「依CC BY-NC-SA 4.0非商业使用，二创同协议授权」，使用的素材已原样存放于 `references`。

DeepSeek 鲸鱼娘：上善无形原创角色，ZipZipPipe 二次设计；本目录作品基于 ZipZipPipe 图像再创作。

提示词和制作流程见 [Prompt](<./Prompt.md>)。

本次改编：正面 A 姿态立绘由内置 imagegen 生成，Tripo P2 生成静态模型，Blender 制作预览；沿用上述署名及 CC BY-NC-SA 4.0。

V2: same design reference, regenerated with Tripo H3.1.
