try:
    from tensorflow.keras.models import Model
    from tensorflow.keras.layers import (
        Input,
        Conv2D,
        MaxPooling2D,
        UpSampling2D,
        concatenate,
        Conv2DTranspose,
        BatchNormalization,
        Dropout,
        Lambda,
        LeakyReLU,
        SpatialDropout2D,
        Reshape,
        MultiHeadAttention,
        LayerNormalization,
        Add,
        Dense,
    )
except ImportError:
    from keras.models import Model
    from keras.layers import (
        Input,
        Conv2D,
        MaxPooling2D,
        UpSampling2D,
        concatenate,
        Conv2DTranspose,
        BatchNormalization,
        Dropout,
        Lambda,
        LeakyReLU,
        SpatialDropout2D,
        Reshape,
        MultiHeadAttention,
        LayerNormalization,
        Add,
        Dense,
    )

"""
The model backbone architecture used was learned and improved based
upon Dr. Sreenivas Bhattiprolu's work:

Bhattiprolu, S. (2023, August 23). 208 - Multiclass semantic segmentation using U-Net [Video]. YouTube. https://youtu.be/q-p8v1Bxvac
Bhattiprolu, S. (2023). python_for_microscopists. GitHub. https://github.com/bnsreenu/python_for_microscopists/blob/master/208-simple_multi_unet_model.py
"""

def multi_unet_model(n_classes, IMG_HEIGHT, IMG_WIDTH, IMG_CHANNELS):
    inputs = Input((IMG_HEIGHT, IMG_WIDTH, IMG_CHANNELS))
    s = inputs

    #contraction path
    c1 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(s)
    c1 = BatchNormalization()(c1)
    c1 = LeakyReLU(alpha=0.1)(c1)
    c1 = SpatialDropout2D(0.1)(c1)
    c1 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c1)
    c1 = BatchNormalization()(c1)
    c1 = LeakyReLU(alpha=0.1)(c1)
    p1 = MaxPooling2D((2, 2))(c1)

    c2 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p1)
    c2 = BatchNormalization()(c2)
    c2 = LeakyReLU(alpha=0.1)(c2)
    c2 = SpatialDropout2D(0.1)(c2)
    c2 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c2)
    c2 = BatchNormalization()(c2)
    c2 = LeakyReLU(alpha=0.1)(c2)
    p2 = MaxPooling2D((2, 2))(c2)

    c3 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p2)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)
    c3 = SpatialDropout2D(0.2)(c3)
    c3 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c3)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)
    p3 = MaxPooling2D((2, 2))(c3)

    c4 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p3)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)
    c4 = SpatialDropout2D(0.2)(c4)
    c4 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c4)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)
    p4 = MaxPooling2D(pool_size=(2, 2))(c4)

    c5 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p4)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)
    c5 = SpatialDropout2D(0.3)(c5)
    c5 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c5)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)
    p5 = MaxPooling2D(pool_size=(2, 2))(c5)

    c6 = Conv2D(512, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p5)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)
    c6 = SpatialDropout2D(0.3)(c6)
    c6 = Conv2D(512, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c6)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)

    u7 = Conv2DTranspose(256, (2, 2), strides=(2, 2), padding='same')(c6)
    u7 = concatenate([u7, c5])
    c7 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u7)
    c7 = BatchNormalization()(c7)
    c7 = LeakyReLU(alpha=0.1)(c7)
    c7 = SpatialDropout2D(0.3)(c7)
    c7 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c7)
    c7 = BatchNormalization()(c7)
    c7 = LeakyReLU(alpha=0.1)(c7)

    #expansive path
    u6 = Conv2DTranspose(128, (2, 2), strides=(2, 2), padding='same')(c7)
    u6 = concatenate([u6, c4])
    c6 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u6)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)
    c6 = SpatialDropout2D(0.2)(c6)
    c6 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c6)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)

    u5 = Conv2DTranspose(64, (2, 2), strides=(2, 2), padding='same')(c6)
    u5 = concatenate([u5, c3])
    c5 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u5)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)
    c5 = SpatialDropout2D(0.2)(c5)
    c5 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c5)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)

    u4 = Conv2DTranspose(32, (2, 2), strides=(2, 2), padding='same')(c5)
    u4 = concatenate([u4, c2])
    c4 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u4)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)
    c4 = SpatialDropout2D(0.1)(c4)
    c4 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c4)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)

    u3 = Conv2DTranspose(16, (2, 2), strides=(2, 2), padding='same')(c4)
    u3 = concatenate([u3, c1], axis=3)
    c3 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u3)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)
    c3 = SpatialDropout2D(0.1)(c3)
    c3 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c3)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)

    outputs = Conv2D(n_classes, (1, 1), activation='softmax')(c3)

    model = Model(inputs=[inputs], outputs=[outputs])


    return model


################################################################
################################################################
def multi_unet_model_trans(n_classes, IMG_HEIGHT, IMG_WIDTH, IMG_CHANNELS):
    inputs = Input((IMG_HEIGHT, IMG_WIDTH, IMG_CHANNELS))
    s = inputs

    #contraction path
    c1 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(s)
    c1 = BatchNormalization()(c1)
    c1 = LeakyReLU(alpha=0.1)(c1)
    c1 = SpatialDropout2D(0.1)(c1)
    c1 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c1)
    c1 = BatchNormalization()(c1)
    c1 = LeakyReLU(alpha=0.1)(c1)
    p1 = MaxPooling2D((2, 2))(c1)

    c2 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p1)
    c2 = BatchNormalization()(c2)
    c2 = LeakyReLU(alpha=0.1)(c2)
    c2 = SpatialDropout2D(0.1)(c2)
    c2 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c2)
    c2 = BatchNormalization()(c2)
    c2 = LeakyReLU(alpha=0.1)(c2)
    p2 = MaxPooling2D((2, 2))(c2)

    c3 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p2)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)
    c3 = SpatialDropout2D(0.2)(c3)
    c3 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c3)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)
    p3 = MaxPooling2D((2, 2))(c3)

    c4 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p3)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)
    c4 = SpatialDropout2D(0.2)(c4)
    c4 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c4)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)
    p4 = MaxPooling2D(pool_size=(2, 2))(c4)

    c5 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p4)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)
    c5 = SpatialDropout2D(0.3)(c5)
    c5 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c5)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)
    p5 = MaxPooling2D(pool_size=(2, 2))(c5)

    c6 = Conv2D(512, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(p5)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)
    c6 = SpatialDropout2D(0.3)(c6)
    c6 = Conv2D(512, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c6)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)

    #Transformer
    seq_h, seq_w = IMG_HEIGHT // 32, IMG_WIDTH // 32
    x = Reshape((seq_h * seq_w, 512))(c6)
    attn_out = MultiHeadAttention(num_heads=4, key_dim=128)(x, x)
    x = Add()([x, attn_out])
    x = LayerNormalization()(x)
    ff = Dense(512 * 4, activation='relu')(x)
    ff = Dense(512)(ff)
    x = Add()([x, ff])
    x = LayerNormalization()(x)
    c6 = Reshape((seq_h, seq_w, 512))(x)

    u7 = Conv2DTranspose(256, (2, 2), strides=(2, 2), padding='same')(c6)
    u7 = concatenate([u7, c5])
    c7 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u7)
    c7 = BatchNormalization()(c7)
    c7 = LeakyReLU(alpha=0.1)(c7)
    c7 = SpatialDropout2D(0.3)(c7)
    c7 = Conv2D(256, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c7)
    c7 = BatchNormalization()(c7)
    c7 = LeakyReLU(alpha=0.1)(c7)


    #expansive path
    u6 = Conv2DTranspose(128, (2, 2), strides=(2, 2), padding='same')(c7)
    u6 = concatenate([u6, c4])
    c6 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u6)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)
    c6 = SpatialDropout2D(0.2)(c6)
    c6 = Conv2D(128, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c6)
    c6 = BatchNormalization()(c6)
    c6 = LeakyReLU(alpha=0.1)(c6)

    u5 = Conv2DTranspose(64, (2, 2), strides=(2, 2), padding='same')(c6)
    u5 = concatenate([u5, c3])
    c5 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u5)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)
    c5 = SpatialDropout2D(0.2)(c5)
    c5 = Conv2D(64, (3, 3), activation=None, kernel_initializer='he_normal',padding='same')(c5)
    c5 = BatchNormalization()(c5)
    c5 = LeakyReLU(alpha=0.1)(c5)

    u4 = Conv2DTranspose(32, (2, 2), strides=(2, 2), padding='same')(c5)
    u4 = concatenate([u4, c2])
    c4 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u4)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)
    c4 = SpatialDropout2D(0.1)(c4)
    c4 = Conv2D(32, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c4)
    c4 = BatchNormalization()(c4)
    c4 = LeakyReLU(alpha=0.1)(c4)

    u3 = Conv2DTranspose(16, (2, 2), strides=(2, 2), padding='same')(c4)
    u3 = concatenate([u3, c1], axis=3)
    c3 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(u3)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)
    c3 = SpatialDropout2D(0.1)(c3)
    c3 = Conv2D(16, (3, 3), activation=None, kernel_initializer='he_normal', padding='same')(c3)
    c3 = BatchNormalization()(c3)
    c3 = LeakyReLU(alpha=0.1)(c3)

    outputs = Conv2D(n_classes, (1, 1), activation='softmax')(c3)

    model = Model(inputs=[inputs], outputs=[outputs])

    return model
