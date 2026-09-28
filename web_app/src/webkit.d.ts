import "react"

// React 的类型定义未包含文件夹上传相关的非标准属性，
// 这里做声明合并，使 JSX 可直接使用 webkitdirectory / directory。
declare module "react" {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string
    directory?: string
  }
}
