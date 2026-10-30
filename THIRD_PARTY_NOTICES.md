# 第三方依赖说明

本项目的 MIT 许可证仅适用于项目自身代码。安装和分发时，第三方包及其传递依赖仍适用各包附带的许可证和版权声明。

下表依据当前锁定版本的包元数据整理，用于定位主要运行时依赖，并非完整的传递依赖清单。

| 包 | 版本 | 许可证 |
|---|---|---|
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| pdfjs-dist | 5.7.284 | Apache-2.0 |
| pdf-lib | 1.17.1 | MIT |
| docx | 9.10.0 | MIT |
| exceljs | 4.4.0 | MIT |
| jszip | 3.10.2 | MIT OR GPL-3.0-or-later |
| lucide-react | 0.468.0 | ISC |

具体版本和依赖关系见 `package-lock.json`；完整许可证见安装后对应包目录中的 `LICENSE`、`LICENSE.md`、`LICENSE.txt` 或 `NOTICE` 等文件。更新依赖后应同步检查本表。

生产构建所生成的许可证注释或通知不应随意删除。重新分发第三方代码时应同时保留其适用的版权、许可及 NOTICE 要求。
